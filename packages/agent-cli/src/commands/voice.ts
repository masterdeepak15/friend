import { Audit, Auth, Voiceprint, loadConfig, openDb } from "@friend/server";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IO } from "../cli";

export type Runner = (
  cmd: string,
  args: string[],
  opts?: { cwd?: string; onLine?: (line: string) => void },
) => Promise<{ code: number; stdout: string }>;

export interface VoiceSetupDeps {
  run?: Runner;
  /** Folder containing the friend_voice Python package. */
  voiceDir?: string;
}

export interface VoiceMarker {
  python: string;
  sttModel: string;
  ttsVoice: string;
  at: number;
}

export function voicePaths(dataDir: string) {
  const home = join(dataDir, "voice");
  const venv = join(home, "venv");
  return {
    home,
    venv,
    python: process.platform === "win32" ? join(venv, "Scripts", "python.exe") : join(venv, "bin", "python"),
    models: join(home, "models"),
    marker: join(home, "installed.json"),
  };
}

export function readMarker(dataDir: string): VoiceMarker | null {
  try {
    return JSON.parse(readFileSync(voicePaths(dataDir).marker, "utf8")) as VoiceMarker;
  } catch {
    return null;
  }
}

export function findVoiceDir(): string {
  return process.env.FRIEND_VOICE_DIR ?? resolve(dirname(fileURLToPath(import.meta.url)), "../../../voice");
}

/** Keeps Python output readable: no Hugging Face symlink warning, UTF-8 everywhere. */
export const QUIET_ENV = { ...process.env, HF_HUB_DISABLE_SYMLINKS_WARNING: "1", PYTHONUTF8: "1" };

export const defaultRunner: Runner = (cmd, args, opts) =>
  new Promise((res) => {
    let stdout = "";
    const child = spawn(cmd, args, { cwd: opts?.cwd, env: QUIET_ENV, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    const feed = (d: Buffer) => {
      const s = d.toString();
      stdout += s;
      if (opts?.onLine) for (const line of s.split(/\r?\n/)) if (line.trim()) opts.onLine(line);
    };
    child.stdout.on("data", feed);
    child.stderr.on("data", feed);
    child.on("error", (e) => res({ code: 127, stdout: stdout + e.message }));
    child.on("close", (code) => res({ code: code ?? 1, stdout }));
  });

const tail = (s: string, n = 8) => s.trim().split(/\r?\n/).slice(-n).join("\n");

async function findPython(run: Runner): Promise<{ cmd: string; args: string[] } | null> {
  const candidates: [string, string[]][] = [
    ...(process.env.FRIEND_PYTHON ? ([[process.env.FRIEND_PYTHON, []]] as [string, string[]][]) : []),
    ["python", []],
    ["py", ["-3"]],
    ["python3", []],
  ];
  for (const [cmd, pre] of candidates) {
    const r = await run(cmd, [...pre, "--version"]);
    const m = /Python (\d+)\.(\d+)/.exec(r.stdout);
    if (r.code === 0 && m && (Number(m[1]) > 3 || (Number(m[1]) === 3 && Number(m[2]) >= 10))) return { cmd, args: pre };
  }
  return null;
}

export async function voiceSetupCommand(io: IO, deps: VoiceSetupDeps = {}): Promise<number> {
  const run = deps.run ?? defaultRunner;
  const voiceDir = deps.voiceDir ?? findVoiceDir();
  const cfg = loadConfig(io.dataDir);
  const p = voicePaths(io.dataDir);
  const onLine = (l: string) => io.out(`    ${l}`);

  io.out("Setting up local voice (speech to text and text to speech). This downloads about 250 MB once.");
  const py = await findPython(run);
  if (!py) {
    io.err("Python 3.10 or newer is required. Install it from https://www.python.org/downloads/ and run this again.");
    return 1;
  }

  mkdirSync(p.home, { recursive: true });
  if (!existsSync(p.python)) {
    io.out("1/3 Creating a private Python environment…");
    const r = await run(py.cmd, [...py.args, "-m", "venv", p.venv], { onLine });
    if (r.code !== 0) {
      io.err(`Could not create the Python environment.\n${tail(r.stdout)}`);
      return 1;
    }
  }

  io.out("2/3 Installing the speech packages…");
  const pip = await run(p.python, ["-m", "pip", "install", "--disable-pip-version-check", "faster-whisper>=1.2,<2", "piper-tts>=1.8,<2", "sherpa-onnx>=1.13,<2", "av>=15,<19"], { onLine });
  if (pip.code !== 0) {
    io.err(`Could not install the speech packages.\n${tail(pip.stdout)}`);
    return 1;
  }

  io.out(`3/3 Downloading the speech models (${cfg.voice.sttModel}, ${cfg.voice.ttsVoice})…`);
  const models = p.models.replace(/\\/g, "/");
  const code = `from friend_voice.models import load_engines; load_engines(${JSON.stringify(models)}, ${JSON.stringify(cfg.voice.sttModel)}, ${JSON.stringify(cfg.voice.ttsVoice)}); print("models ready")`;
  const dl = await run(p.python, ["-c", code], { cwd: voiceDir, onLine });
  if (dl.code !== 0) {
    io.err(`Could not download the speech models.\n${tail(dl.stdout)}`);
    return 1;
  }

  const marker: VoiceMarker = { python: p.python, sttModel: cfg.voice.sttModel, ttsVoice: cfg.voice.ttsVoice, at: Date.now() };
  writeFileSync(p.marker, JSON.stringify(marker, null, 2));
  io.out("Voice is ready. Start Friend with `friend start`, then hold Space to talk.");
  return 0;
}

export async function voiceStatusCommand(io: IO): Promise<number> {
  const cfg = loadConfig(io.dataDir);
  const marker = readMarker(io.dataDir);
  io.out(`Voice enabled:  ${cfg.voice.enabled ? "yes" : "no"}`);
  const print = readVoiceprint(io.dataDir);
  io.out(
    `Speaker recognition: ${
      print ? `enrolled (${print.samples} samples, ${new Date(print.createdAt).toLocaleDateString()})` : "not set up. Open the owner menu (Esc) and choose Enroll my voice."
    }`,
  );
  if (!marker) {
    io.out("Voice engine:   not installed. Run: friend voice setup");
    return 0;
  }
  if (!existsSync(marker.python)) {
    io.out("Voice engine:   installed, but its Python is missing. Run: friend voice setup");
    return 0;
  }
  io.out("Voice engine:   installed");
  io.out(`Speech to text: ${marker.sttModel}`);
  io.out(`Voice:          ${marker.ttsVoice}`);
  if (marker.sttModel !== cfg.voice.sttModel || marker.ttsVoice !== cfg.voice.ttsVoice) {
    io.out("The config asks for different models than the ones installed. Run: friend voice setup");
  }
  return 0;
}

/** Reads the enrollment record without touching the key: only the averaged voice is secret, not whether one exists. */
function readVoiceprint(dataDir: string): { samples: number; createdAt: number } | null {
  const db = openDb(dataDir);
  try {
    return new Voiceprint(db, Buffer.alloc(32)).info();
  } finally {
    db.close();
  }
}

/** Deletes the saved voiceprint after checking the owner's PIN. Recognition is off afterwards: every voice counts as the owner's. */
export async function voiceForgetCommand(io: IO): Promise<number> {
  const db = openDb(io.dataDir);
  try {
    const print = new Voiceprint(db, Buffer.alloc(32));
    if (!print.exists()) {
      io.out("There is no saved voice to delete.");
      return 0;
    }
    const auth = new Auth(db, new Audit(db));
    const pin = await io.ask("Owner PIN: ", { hidden: true });
    let ok = false;
    try {
      ok = await auth.verifyPin(pin.trim(), "cli");
    } catch (e) {
      io.err((e as Error).message);
      return 1;
    }
    if (!ok) {
      io.err("Incorrect PIN. Your saved voice was kept.");
      return 1;
    }
    print.clear();
    new Audit(db).log("owner", "voice.removed", { via: "cli" });
    io.out("Your saved voice was deleted. Every voice is treated as yours until you enroll again.");
    return 0;
  } finally {
    db.close();
  }
}

export async function voiceCommand(args: string[], io: IO): Promise<number> {
  switch (args[0]) {
    case "setup":
      return voiceSetupCommand(io);
    case "status":
      return voiceStatusCommand(io);
    case "forget":
      return voiceForgetCommand(io);
    default:
      io.err("Usage: friend voice setup | friend voice status | friend voice forget");
      return 1;
  }
}
