import { ORIGINAL_VOICE, VOICE_CHOICES, resolveVoice, voiceLabel, type VoiceChoice } from "@friend/protocol";
import { Audit, Auth, Voiceprint, loadConfig, openDb, saveConfig, firstExistingDir } from "@friend/server";
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
  const here = dirname(fileURLToPath(import.meta.url));
  return firstExistingDir([process.env.FRIEND_VOICE_DIR, resolve(here, "voice"), resolve(here, "../../../voice")], "friend_voice") ?? resolve(here, "voice");
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

export async function findPython(run: Runner): Promise<{ cmd: string; args: string[] } | null> {
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

/** The list of voices to choose from, numbered, with the current one marked. */
export function voiceMenu(current: string): string[] {
  const line = (i: number, v: VoiceChoice) => `  ${String(i + 1).padStart(2)}  ${v.name.padEnd(9)} ${v.accent}${v.note ? `, ${v.note}` : ""}${v.id === current ? "   <- now" : ""}`;
  const female = VOICE_CHOICES.map((v, i) => [i, v] as const).filter(([, v]) => v.gender === "female");
  const male = VOICE_CHOICES.map((v, i) => [i, v] as const).filter(([, v]) => v.gender === "male");
  return [
    "Female voices",
    ...female.map(([i, v]) => line(i, v)),
    "Male voices",
    ...male.map(([i, v]) => line(i, v)),
    `The original voice (${ORIGINAL_VOICE.name}, ${ORIGINAL_VOICE.accent})${current === ORIGINAL_VOICE.id ? "   <- now" : ""}: type ${ORIGINAL_VOICE.name.toLowerCase()}`,
  ];
}

/** Which voice the flags ask for, or null when they do not. Throws a sentence for a voice that does not exist. */
function voiceFromFlags(args: string[]): string | null {
  if (args.includes("--female")) return resolveVoice("female")!.id;
  if (args.includes("--male")) return resolveVoice("male")!.id;
  const i = args.indexOf("--voice");
  if (i < 0) return null;
  const r = resolveVoice(args[i + 1] ?? "");
  if (!r) throw new Error(`"${args[i + 1] ?? ""}" is not a voice. Run: friend voice list`);
  return r.id;
}

export async function voiceSetupCommand(io: IO, deps: VoiceSetupDeps = {}, args: string[] = []): Promise<number> {
  const run = deps.run ?? defaultRunner;
  const voiceDir = deps.voiceDir ?? findVoiceDir();
  const cfg = loadConfig(io.dataDir);
  const p = voicePaths(io.dataDir);
  const onLine = (l: string) => io.out(`    ${l}`);

  io.out("Setting up local voice (speech to text and text to speech). This downloads about 250 MB once.");

  // which voice speaks: a flag, or a short question (Enter keeps the current one)
  let chosen: string | null;
  try {
    chosen = voiceFromFlags(args);
  } catch (e) {
    io.err((e as Error).message);
    return 1;
  }
  if (!chosen) {
    io.out("");
    io.out("Choose the assistant's voice:");
    for (const l of voiceMenu(cfg.voice.ttsVoice)) io.out(l);
    for (let tries = 0; tries < 3 && !chosen; tries++) {
      const answer = (await io.ask(`Voice (a number, "female" or "male"; Enter keeps ${voiceLabel(cfg.voice.ttsVoice)}): `)).trim();
      if (!answer) break;
      const r = resolveVoice(answer);
      if (r) chosen = r.id;
      else io.out(`"${answer}" is not on the list. Try a number from 1 to ${VOICE_CHOICES.length}, "female" or "male".`);
    }
  }
  if (chosen && chosen !== cfg.voice.ttsVoice) {
    cfg.voice.ttsVoice = chosen;
    saveConfig(cfg);
    io.out(`Voice: ${voiceLabel(chosen)}. You can change it any time in Settings (Voice tab) or with: friend voice setup`);
  }
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
  // The Hindi and Marathi voices come too, so the first reply in those languages does not wait for a download. They are optional: a failure only prints a note.
  const extra = [cfg.voice.hindiVoice, cfg.voice.marathiVoice].filter((v) => /^[A-Za-z0-9_-]+$/.test(v));
  const code =
    `from friend_voice.models import load_engines; load_engines(${JSON.stringify(models)}, ${JSON.stringify(cfg.voice.sttModel)}, ${JSON.stringify(cfg.voice.ttsVoice)}); print("models ready")\n` +
    `from pathlib import Path\nfrom friend_voice.tts import ensure_voice\n` +
    `for v in ${JSON.stringify(extra)}:\n    try:\n        ensure_voice(v, Path(${JSON.stringify(models)}) / "piper"); print("voice ready", v)\n    except Exception as e:\n        print("note: could not download the voice", v, "-", e, "(it downloads when first used)")`;
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
      return voiceSetupCommand(io, {}, args.slice(1));
    case "list": {
      const cfg = loadConfig(io.dataDir);
      for (const l of voiceMenu(cfg.voice.ttsVoice)) io.out(l);
      io.out("Choose one with: friend voice setup --voice <number or name>   (or --female / --male)");
      return 0;
    }
    case "status":
      return voiceStatusCommand(io);
    case "forget":
      return voiceForgetCommand(io);
    default:
      io.err("Usage: friend voice setup [--voice <name>|--female|--male] | friend voice list | friend voice status | friend voice forget");
      return 1;
  }
}
