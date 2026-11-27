import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Raw 16-bit mono PCM as a WAV file. */
export function pcmToWav(pcm: Buffer, sampleRate = 16000): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write("WAVEfmt ", 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** Turns text into a spoken WAV, or null when this PC has no voice for it. */
export type Speech = (text: string) => Promise<Buffer | null>;

const WINDOWS = `Add-Type -AssemblyName System.Speech; $s = New-Object System.Speech.Synthesis.SpeechSynthesizer; $s.SetOutputToWaveFile($env:FRIEND_TTS_OUT); $s.Speak($env:FRIEND_TTS_TEXT); $s.Dispose()`;

const run = (file: string, args: string[], env: Record<string, string>, input?: string): Promise<boolean> =>
  new Promise((resolve) => {
    const c = execFile(file, args, { env: { ...process.env, ...env }, timeout: 45_000, windowsHide: true }, (e) => resolve(!e));
    if (input !== undefined) c.stdin?.end(input);
  });

/**
 * The voice the PC already has, so it costs nothing: Windows speech (SAPI), macOS `say`, or `espeak-ng` on Linux. The text goes in through
 * the environment or standard input, never into a command line.
 */
export function systemSpeech(): Speech {
  return async (text) => {
    const dir = mkdtempSync(join(tmpdir(), "friend-tts-"));
    const out = join(dir, "say.wav");
    try {
      const t = text.replace(/\s+/g, " ").trim().slice(0, 600);
      if (!t) return null;
      let ok = false;
      if (process.platform === "win32") ok = await run("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", WINDOWS], { FRIEND_TTS_OUT: out, FRIEND_TTS_TEXT: t });
      else if (process.platform === "darwin") ok = await run("say", ["-o", out, "--data-format=LEI16@22050", "-f", "-"], {}, t);
      else ok = await run("espeak-ng", ["-w", out, "--stdin"], {}, t);
      return ok ? readFileSync(out) : null;
    } catch {
      return null;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
}
