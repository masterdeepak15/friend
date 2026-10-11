import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { findMpv, Mpv } from "./mpv";

const fake = fileURLToPath(new URL("./testing/fakeMpv.mjs", import.meta.url));

describe("findMpv", () => {
  const ok = (out = "mpv v0.37.0 Copyright (c) 2000-2023 mpv/MPlayer/mplayer2 projects") => async () => ({ code: 0, out });
  const none = async () => ({ code: -1, out: "" });

  it("uses the program the owner set, when it works", async () => {
    const run = vi.fn(ok());
    const r = await findMpv({ program: "C:\\tools\\mpv.exe", platform: "win32", exists: () => true, run });
    expect(r).toEqual({ found: true, path: "C:\\tools\\mpv.exe", version: "0.37.0" });
    expect(run).toHaveBeenCalledWith("C:\\tools\\mpv.exe", ["--version"]);
  });

  it("looks for mpv on the PATH when nothing is set", async () => {
    const run = vi.fn(ok());
    expect(await findMpv({ program: "", platform: "linux", exists: () => false, run })).toMatchObject({ found: true, path: "mpv", version: "0.37.0" });
    expect(run).toHaveBeenCalledWith("mpv", ["--version"]);
  });

  it("then looks in the usual places for each system", async () => {
    const seen: string[] = [];
    const exists = (p: string) => {
      seen.push(p);
      return p.includes("homebrew");
    };
    const mac = await findMpv({ program: "", platform: "darwin", exists, run: async (c) => (c === "mpv" ? { code: -1, out: "" } : { code: 0, out: "mpv 0.36.0" }) });
    expect(mac).toMatchObject({ found: true, path: "/opt/homebrew/bin/mpv", version: "0.36.0" });

    const win = await findMpv({
      program: "",
      platform: "win32",
      env: { ProgramFiles: "C:\\Program Files", LOCALAPPDATA: "C:\\Users\\me\\AppData\\Local", USERPROFILE: "C:\\Users\\me" },
      exists: (p) => p === "C:\\Users\\me\\scoop\\shims\\mpv.exe",
      run: async (c) => (c === "mpv" ? { code: -1, out: "" } : { code: 0, out: "mpv 0.38.0" }),
    });
    expect(win).toMatchObject({ found: true, path: "C:\\Users\\me\\scoop\\shims\\mpv.exe" });
  });

  it("says plainly how to install it, for each system, when it is not found", async () => {
    const win = await findMpv({ program: "", platform: "win32", exists: () => false, run: none });
    const mac = await findMpv({ program: "", platform: "darwin", exists: () => false, run: none });
    const linux = await findMpv({ program: "", platform: "linux", exists: () => false, run: none });
    expect(win).toEqual({ found: false, install: expect.stringContaining("winget install mpv") });
    expect(mac).toEqual({ found: false, install: expect.stringContaining("brew install mpv") });
    expect(linux).toEqual({ found: false, install: expect.stringMatching(/apt install mpv.*dnf install mpv.*pacman -S mpv/) });
  });

  it("a program that is set but is not mpv is not used, and the answer says so", async () => {
    const r = await findMpv({ program: "notmpv", platform: "linux", exists: () => true, run: async () => ({ code: 0, out: "something else 1.0" }) });
    expect(r).toMatchObject({ found: false, install: expect.stringMatching(/not mpv|mpv/i) });
  });
});

describe("Mpv", () => {
  const live: Mpv[] = [];
  const children: ChildProcess[] = [];
  afterEach(() => {
    for (const m of live.splice(0)) m.dispose();
    for (const c of children.splice(0)) c.kill();
  });

  function make(over: { resolve?: () => Promise<{ found: true; path: string; version: string } | { found: false; install: string }>; requestTimeoutMs?: number } = {}) {
    const dir = mkdtempSync(join(tmpdir(), "friend-mpv-"));
    const log = join(dir, "commands.log");
    const argvs: string[][] = [];
    const spawnFake = ((cmd: string, args: string[], opts: object) => {
      argvs.push([cmd, ...args]);
      const c = spawn(process.execPath, [fake, ...args], { ...opts, env: { ...process.env, FAKE_MPV_LOG: log } });
      children.push(c);
      return c;
    }) as unknown as typeof spawn;
    const mpv = new Mpv({ program: () => "mpv", dataDir: dir, spawn: spawnFake, resolve: over.resolve ?? (async () => ({ found: true, path: "mpv", version: "fake" })), ...(over.requestTimeoutMs ? { requestTimeoutMs: over.requestTimeoutMs } : {}) });
    live.push(mpv);
    const commands = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { command: unknown[] }).command) : []);
    return { mpv, dir, argvs, commands, children };
  }
  const events = (m: Mpv) => {
    const got: { type: string; [k: string]: unknown }[] = [];
    m.onEvent((e) => void got.push(e));
    return got;
  };

  it("starts once however many ask, with the flags Friend needs", async () => {
    const t = make();
    const [a, b] = await Promise.all([t.mpv.start(), t.mpv.start()]);
    expect([a, b]).toEqual([{ ok: true }, { ok: true }]);
    expect(t.argvs).toHaveLength(1);
    const args = t.argvs[0]!;
    expect(args).toEqual(expect.arrayContaining(["--no-video", "--idle=yes", "--no-terminal"]));
    expect(args.some((x) => x.startsWith("--input-ipc-server="))).toBe(true);
    await t.mpv.start();
    expect(t.argvs).toHaveLength(1);
  });

  it("when mpv is not there it says so in one sentence, with no path of the pipe", async () => {
    const t = make({ resolve: async () => ({ found: false, install: "mpv is not installed. Install it with: winget install mpv." }) });
    const r = await t.mpv.start();
    expect(r).toEqual({ ok: false, error: expect.stringContaining("winget install mpv") });
    expect(JSON.stringify(r)).not.toMatch(/pipe|\.sock/);
    expect(t.argvs).toHaveLength(0);
  });

  it("loads a file through the IPC, never as an argument, however the file is named", async () => {
    const t = make();
    await t.mpv.load("C:\\Music\\--vo=null evil.mp3");
    expect(t.argvs.flat().some((x) => x.includes("evil"))).toBe(false);
    expect(t.commands()).toContainEqual(["loadfile", "C:\\Music\\--vo=null evil.mp3", "replace"]);
  });

  it("turns what mpv reports into events: time, pause, the end of a track, a file that will not open", async () => {
    const t = make();
    const got = events(t.mpv);
    await t.mpv.load("/m/a-EOF.mp3");
    await vi.waitFor(() => expect(got.map((e) => e.type)).toContain("ended"));
    expect(got).toContainEqual(expect.objectContaining({ type: "time", position: 1.5, duration: 200 }));
    await t.mpv.pause(true);
    await vi.waitFor(() => expect(got).toContainEqual({ type: "paused", paused: true }));
    await t.mpv.load("/m/FAILFILE.mp3");
    await vi.waitFor(() => expect(got).toContainEqual({ type: "failed", reason: expect.stringMatching(/open|play/i) }));
  });

  it("sends seek, volume and mute to mpv", async () => {
    const t = make();
    await t.mpv.start();
    await t.mpv.seek(42);
    await t.mpv.volume(55);
    await t.mpv.mute(true);
    await t.mpv.stop();
    const c = t.commands();
    expect(c).toContainEqual(["seek", 42, "absolute"]);
    expect(c).toContainEqual(["set_property", "volume", 55]);
    expect(c).toContainEqual(["set_property", "mute", true]);
    expect(c).toContainEqual(["stop"]);
  });

  it("when mpv dies it says so, and the next call starts it again", async () => {
    const t = make();
    const got = events(t.mpv);
    await t.mpv.load("/m/a.mp3");
    await t.mpv.load("/m/CRASH.mp3").catch(() => {});
    await vi.waitFor(() => expect(got.map((e) => e.type)).toContain("exited"));
    await t.mpv.load("/m/b.mp3");
    expect(t.argvs).toHaveLength(2);
  });

  it("gives up on a request mpv never answers, in a sentence", async () => {
    const t = make({ requestTimeoutMs: 100 });
    await expect(t.mpv.load("/m/HANG.mp3")).rejects.toThrow(/did not answer/i);
  });

  it("dispose ends the program and leaves no socket file; a second one next to it gets its own pipe", async () => {
    const a = make();
    const b = make();
    await Promise.all([a.mpv.start(), b.mpv.start()]);
    const pipe = (t: { argvs: string[][] }) => t.argvs[0]!.find((x) => x.startsWith("--input-ipc-server="));
    expect(pipe(a)).not.toBe(pipe(b));
    a.mpv.dispose();
    await vi.waitFor(() => expect(a.children[0]!.exitCode !== null || a.children[0]!.killed).toBe(true));
    if (process.platform !== "win32") expect(existsSync(pipe(a)!.slice("--input-ipc-server=".length))).toBe(false);
    expect((await b.mpv.start()).ok).toBe(true);
  });
});
