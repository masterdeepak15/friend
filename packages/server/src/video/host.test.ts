import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { VideoHost } from "./host";

const fake = fileURLToPath(new URL("../music/testing/fakeMpv.mjs", import.meta.url));

const live: VideoHost[] = [];
const children: ChildProcess[] = [];
afterEach(() => {
  for (const h of live.splice(0)) h.dispose();
  for (const c of children.splice(0)) c.kill();
});

function make(over: { found?: boolean; ytdlp?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "friend-videohost-"));
  const log = join(dir, "commands.log");
  const argvs: string[][] = [];
  const spawnFake = ((cmd: string, args: string[], opts: object) => {
    argvs.push([cmd, ...args]);
    const c = spawn(process.execPath, [fake, ...args], { ...opts, env: { ...process.env, FAKE_MPV_LOG: log } });
    children.push(c);
    return c;
  }) as unknown as typeof spawn;
  const host = new VideoHost({
    program: () => "mpv",
    ytdlp: () => over.ytdlp ?? "/usr/bin/yt-dlp",
    dataDir: dir,
    spawn: spawnFake,
    resolve: async () => (over.found === false ? { found: false, install: "mpv is not installed. Install it with: winget install mpv." } : { found: true, path: "mpv", version: "fake" }),
  });
  live.push(host);
  const commands = () => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter(Boolean).map((l) => (JSON.parse(l) as { command: unknown[] }).command) : []);
  return { host, argvs, commands };
}

describe("the window on the PC", () => {
  it("starts mpv with a window and its own yt-dlp link, and the same safety flags as the music player", async () => {
    const t = make();
    expect(await t.host.open("https://www.youtube.com/watch?v=x", { start: 0, maxHeight: 720 })).toEqual({ ok: true });
    const a = t.argvs[0]!;
    expect(a).toEqual(expect.arrayContaining(["--idle=yes", "--no-terminal", "--force-window=yes", "--keep-open=no", "--ytdl=yes", "--access-references=no", "--tls-verify=yes"]));
    expect(a).not.toContain("--no-video");
    expect(a).not.toContain("--ytdl=no");
    expect(a.some((x) => x.startsWith("--input-ipc-server="))).toBe(true);
  });

  it("tells mpv which yt-dlp to use and runs it the way Friend runs it: no config, no playlist", async () => {
    const t = make({ ytdlp: "C:/tools/yt-dlp.exe" });
    await t.host.open("https://www.youtube.com/watch?v=x", { start: 0, maxHeight: 720 });
    const a = t.argvs[0]!;
    expect(a).toContain("--script-opts=ytdl_hook-ytdl_path=C:/tools/yt-dlp.exe");
    const raw = a.find((x) => x.startsWith("--ytdl-raw-options="))!;
    expect(raw).toMatch(/ignore-config=/);
    expect(raw).toMatch(/no-playlist=/);
  });

  it("sends the link through the IPC, never as an argument, with the height and the start time for it", async () => {
    const t = make();
    await t.host.open("https://www.youtube.com/watch?v=x --vo=null", { start: 95, maxHeight: 480 });
    expect(t.argvs.flat().some((x) => x.includes("watch?v="))).toBe(false);
    const c = t.commands();
    expect(c).toContainEqual(["set_property", "ytdl-format", "bv*[height<=480]+ba/b[height<=480]/b"]);
    expect(c).toContainEqual(["set_property", "start", "95"]);
    expect(c).toContainEqual(["loadfile", "https://www.youtube.com/watch?v=x --vo=null", "replace"]);
    expect(c).toContainEqual(["set_property", "pause", false]);
  });

  it("forgets the old start time for the next video", async () => {
    const t = make();
    await t.host.open("https://a.example.org/1", { start: 95, maxHeight: 720 });
    await t.host.open("https://a.example.org/2", { start: 0, maxHeight: 720 });
    const starts = t.commands().filter((c) => c[0] === "set_property" && c[1] === "start").map((c) => c[2]);
    expect(starts).toEqual(["95", "0"]);
    expect(t.argvs).toHaveLength(1); // the same mpv
  });

  it("pauses, resumes, seeks, sets the volume and stops", async () => {
    const t = make();
    await t.host.open("https://a.example.org/1", { start: 0, maxHeight: 720 });
    await t.host.pause(true);
    await t.host.pause(false);
    await t.host.seek(75);
    await t.host.volume(40);
    await t.host.stop();
    const c = t.commands();
    expect(c).toContainEqual(["set_property", "pause", true]);
    expect(c).toContainEqual(["seek", 75, "absolute"]);
    expect(c).toContainEqual(["set_property", "volume", 40]);
    expect(c).toContainEqual(["stop"]);
  });

  it("says in one sentence when mpv is not there", async () => {
    const t = make({ found: false });
    expect(await t.host.open("https://a.example.org/1", { start: 0, maxHeight: 720 })).toEqual({ ok: false, error: expect.stringContaining("winget install mpv") });
    expect(t.argvs).toEqual([]);
  });
});
