import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { loadConfig } from "@friend/server";
import { run, type IO } from "./cli";
import { voicePaths, voiceSetupCommand, type Runner } from "./commands/voice";
import { startFriend, type RunningFriend } from "./commands/start";

let dataDir: string;
let lines: string[];
const running: RunningFriend[] = [];

const makeIo = (): IO => ({ dataDir, out: (s) => lines.push(s), err: (s) => lines.push(s), ask: async () => "" });
const text = () => lines.join(" | ");

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "friend-voice-cli-"));
  lines = [];
});
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

type Call = { cmd: string; args: string[]; cwd?: string };

/** A fake command runner: records calls and answers from a script keyed by a substring of the command line. */
function fakeRunner(answers: Record<string, { code: number; stdout?: string }> = {}): { run: Runner; calls: Call[] } {
  const calls: Call[] = [];
  const run: Runner = async (cmd, args, opts) => {
    calls.push({ cmd, args, cwd: opts?.cwd });
    const line = [cmd, ...args].join(" ");
    for (const [key, val] of Object.entries(answers)) if (line.includes(key)) return { code: val.code, stdout: val.stdout ?? "" };
    if (args.includes("--version")) return { code: 0, stdout: "Python 3.12.4" };
    if (args.includes("venv")) {
      // pretend the venv was created
      const p = voicePaths(dataDir);
      mkdirSync(join(p.venv, process.platform === "win32" ? "Scripts" : "bin"), { recursive: true });
      writeFileSync(p.python, "");
    }
    return { code: 0, stdout: "" };
  };
  return { run, calls };
}

describe("friend voice setup", () => {
  it("creates a private venv, installs the engines, downloads the models and records the install", async () => {
    const { run: runner, calls } = fakeRunner();
    expect(await voiceSetupCommand(makeIo(), { run: runner, voiceDir: "/repo/packages/voice" })).toBe(0);
    const p = voicePaths(dataDir);
    const flat = calls.map((c) => [c.cmd, ...c.args].join(" "));
    expect(flat.some((l) => /-m venv/.test(l) && l.includes(p.venv))).toBe(true);
    const pip = flat.find((l) => /pip install/.test(l))!;
    for (const pkg of ["faster-whisper", "piper-tts", "sherpa-onnx", "av>=15,<19"]) expect(pip).toContain(pkg);
    const dl = calls.find((c) => c.args.includes("-c") && c.args.join(" ").includes("load_engines"))!;
    expect(dl.cwd).toBe("/repo/packages/voice");
    expect(dl.args.join(" ")).toContain(p.models.replace(/\\/g, "/"));
    const marker = JSON.parse(readFileSync(p.marker, "utf8"));
    expect(marker).toMatchObject({ python: p.python, sttModel: "base", ttsVoice: "en_US-lessac-medium" });
    expect(text()).toMatch(/voice is ready/i);
  });

  it("uses the models chosen in the config", async () => {
    const cfg = loadConfig(dataDir);
    cfg.voice = { ...cfg.voice, sttModel: "small", ttsVoice: "hi_IN-pratham-medium" };
    (await import("@friend/server")).saveConfig(cfg);
    const { run: runner, calls } = fakeRunner();
    await voiceSetupCommand(makeIo(), { run: runner, voiceDir: "/v" });
    const dl = calls.find((c) => c.args.join(" ").includes("load_engines"))!.args.join(" ");
    expect(dl).toContain("small");
    expect(dl).toContain("hi_IN-pratham-medium");
  });

  it("explains how to get Python when none is found or it is too old", async () => {
    const none = fakeRunner({ "--version": { code: 1 } });
    expect(await voiceSetupCommand(makeIo(), { run: none.run, voiceDir: "/v" })).toBe(1);
    expect(text()).toMatch(/python 3\.10/i);
    lines = [];
    const old = fakeRunner({ "--version": { code: 0, stdout: "Python 3.9.1" } });
    expect(await voiceSetupCommand(makeIo(), { run: old.run, voiceDir: "/v" })).toBe(1);
    expect(text()).toMatch(/python 3\.10/i);
    expect(existsSync(voicePaths(dataDir).marker)).toBe(false);
  });

  it("stops at the first failing step, says which, and records nothing", async () => {
    const r = fakeRunner({ "pip install": { code: 1, stdout: "ERROR: no matching distribution" } });
    expect(await voiceSetupCommand(makeIo(), { run: r.run, voiceDir: "/v" })).toBe(1);
    expect(text()).toMatch(/install the speech packages/i);
    expect(text()).toMatch(/no matching distribution/);
    expect(existsSync(voicePaths(dataDir).marker)).toBe(false);
    expect(r.calls.some((c) => c.args.join(" ").includes("load_engines"))).toBe(false);
  });

  it("reports a failed model download without recording the install", async () => {
    const r = fakeRunner({ load_engines: { code: 1, stdout: "ConnectionError" } });
    expect(await voiceSetupCommand(makeIo(), { run: r.run, voiceDir: "/v" })).toBe(1);
    expect(text()).toMatch(/download the speech models/i);
    expect(existsSync(voicePaths(dataDir).marker)).toBe(false);
  });
});

describe("friend voice status", () => {
  it("says voice is not installed and how to install it", async () => {
    expect(await run(["voice", "status"], makeIo())).toBe(0);
    expect(text()).toMatch(/not installed/i);
    expect(text()).toMatch(/friend voice setup/);
  });

  it("reports an installed voice with its models, and never prints secrets", async () => {
    const p = voicePaths(dataDir);
    mkdirSync(join(p.venv, process.platform === "win32" ? "Scripts" : "bin"), { recursive: true });
    writeFileSync(p.python, "");
    writeFileSync(p.marker, JSON.stringify({ python: p.python, sttModel: "base", ttsVoice: "en_US-lessac-medium", at: 1 }));
    expect(await run(["voice", "status"], makeIo())).toBe(0);
    expect(text()).toMatch(/installed/i);
    expect(text()).toContain("base");
    expect(text()).toContain("en_US-lessac-medium");
    expect(text()).not.toMatch(/token|secret/i);
  });

  it("flags an install whose Python has gone missing", async () => {
    const p = voicePaths(dataDir);
    mkdirSync(p.home, { recursive: true });
    writeFileSync(p.marker, JSON.stringify({ python: join(dataDir, "gone", "python.exe"), sttModel: "base", ttsVoice: "x", at: 1 }));
    await run(["voice", "status"], makeIo());
    expect(text()).toMatch(/missing|broken|run: friend voice setup/i);
  });

  it("rejects an unknown voice subcommand", async () => {
    expect(await run(["voice", "dance"], makeIo())).toBe(1);
  });
});

describe("friend voice status / forget (speaker recognition)", () => {
  const pin = "246810";
  /** An owner with a PIN and, optionally, an enrolled voiceprint in this data dir. */
  async function seed(enrolled: boolean) {
    const { openDb, Auth, Audit, Voiceprint } = await import("@friend/server");
    const db = openDb(dataDir);
    await new Auth(db, new Audit(db)).setupOwner({ password: "correct horse battery", pin, assistantName: "Jarvis" });
    const vp = new Voiceprint(db, Buffer.alloc(32, 1));
    const enroll = () => vp.enroll([[1, 0, 0], [0.9, 0.1, 0], [0.95, 0, 0.05]], "test-model");
    if (enrolled) enroll();
    return { enroll, exists: () => vp.exists(), close: () => db.close() };
  }
  const withPin = (answer: string): IO => ({ ...makeIo(), ask: async () => answer });

  it("status says whether the owner's voice is enrolled", async () => {
    const s = await seed(false);
    await run(["voice", "status"], makeIo());
    expect(text()).toMatch(/speaker recognition:\s+not set up/i);
    lines = [];
    s.enroll();
    await run(["voice", "status"], makeIo());
    expect(text()).toMatch(/speaker recognition:\s+enrolled \(3 samples/i);
    s.close();
  });

  it("forget removes the voiceprint after the right PIN", async () => {
    const s = await seed(true);
    expect(await run(["voice", "forget"], withPin(pin))).toBe(0);
    expect(s.exists()).toBe(false);
    expect(text()).toMatch(/deleted/i);
    s.close();
  });

  it("forget keeps the voiceprint on a wrong PIN", async () => {
    const s = await seed(true);
    expect(await run(["voice", "forget"], withPin("000000"))).toBe(1);
    expect(s.exists()).toBe(true);
    expect(text()).toMatch(/incorrect pin/i);
    s.close();
  });

  it("forget says so when there is nothing to forget, without asking for the PIN", async () => {
    const s = await seed(false);
    s.close();
    const io = { ...makeIo(), ask: async () => { throw new Error("must not ask"); } };
    expect(await run(["voice", "forget"], io)).toBe(0);
    expect(text()).toMatch(/no (saved )?voice/i);
  });
});

describe("voice settings in friend config", () => {
  const set = (k: string, v: string) => run(["config", "set", k, v], makeIo());
  it("stores nested voice settings with the right types", async () => {
    expect(await set("voice.enabled", "false")).toBe(0);
    expect(await set("voice.sttModel", "small")).toBe(0);
    expect(await set("voice.ttsVoice", "hi_IN-pratham-medium")).toBe(0);
    expect(await set("voice.language", "hi")).toBe(0);
    expect(loadConfig(dataDir).voice).toEqual({ enabled: false, sttModel: "small", ttsVoice: "hi_IN-pratham-medium", language: "hi", speakTyped: true, accept: 0.72, challenge: 0.58 });
    expect(await set("voice.speakTyped", "false")).toBe(0);
    expect(loadConfig(dataDir).voice.speakTyped).toBe(false);
    expect(await set("voice.speakTyped", "maybe")).toBe(1);
    expect(await set("voice.language", "")).toBe(0);
    expect(loadConfig(dataDir).voice.language).toBeNull();
  });
  it("rejects bad values and unknown voice keys", async () => {
    expect(await set("voice.enabled", "maybe")).toBe(1);
    expect(await set("voice.nonsense", "x")).toBe(1);
  });
});

describe("friend start with voice", () => {
  it("starts normally and reports voice unavailable when voice is not installed", async () => {
    const f = await startFriend({ dataDir, port: 0, out: (s) => lines.push(s) });
    running.push(f);
    expect(f.app.config.voice.enabled).toBe(true);
    expect(f.voiceAvailable()).toBe(false);
  });

  it("starts normally when the recorded Python is broken, with a visible notice", async () => {
    const p = voicePaths(dataDir);
    mkdirSync(p.home, { recursive: true });
    writeFileSync(p.marker, JSON.stringify({ python: join(dataDir, "nope", "python.exe"), sttModel: "base", ttsVoice: "x", at: 1 }));
    const f = await startFriend({ dataDir, port: 0, out: (s) => lines.push(s), voiceDir: dataDir });
    running.push(f);
    await new Promise((r) => setTimeout(r, 500));
    expect(f.voiceAvailable()).toBe(false);
    expect(text()).toMatch(/voice.*(unavailable|could not start)/i);
  });

  it("does not launch the sidecar when voice is disabled in the config", async () => {
    const cfg = loadConfig(dataDir);
    cfg.voice.enabled = false;
    (await import("@friend/server")).saveConfig(cfg);
    const p = voicePaths(dataDir);
    mkdirSync(p.home, { recursive: true });
    writeFileSync(p.marker, JSON.stringify({ python: "definitely-missing", sttModel: "base", ttsVoice: "x", at: 1 }));
    const f = await startFriend({ dataDir, port: 0, out: (s) => lines.push(s), voiceDir: dataDir });
    running.push(f);
    expect(text()).not.toMatch(/could not start/i);
    expect(f.voiceAvailable()).toBe(false);
  });
});
