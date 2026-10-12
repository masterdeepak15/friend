import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import type { Config } from "../config";
import { findMpv, type FindResult } from "../music/mpv";
import { managedPath } from "./provision";
import type { HelperStatus, VideoStatus } from "./types";

export type HelperName = "yt-dlp" | "ffmpeg";

export interface FindHelperDeps {
  /** What the owner set (a name or a path), or empty to look around. */
  program: string;
  /** The copy Friend downloaded itself (tried after the owner's own choice and before the PATH). */
  managed?: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  exists?: (p: string) => boolean;
  run?: (cmd: string, args: string[]) => Promise<{ code: number; out: string }>;
}

const INSTALL: Record<HelperName, Record<"win32" | "darwin" | "other", string>> = {
  "yt-dlp": {
    win32: "yt-dlp is not installed. Install it once with: winget install yt-dlp (or scoop install yt-dlp, or pip install -U yt-dlp), then try again. Keep it up to date with: yt-dlp -U.",
    darwin: "yt-dlp is not installed. Install it once with: brew install yt-dlp, then try again. Keep it up to date with: brew upgrade yt-dlp.",
    other: "yt-dlp is not installed. Install it once with: pipx install yt-dlp (or your package manager, for example sudo apt install yt-dlp or sudo pacman -S yt-dlp), then try again. Keep it up to date with: yt-dlp -U.",
  },
  ffmpeg: {
    win32: "ffmpeg is not installed. Install it once with: winget install ffmpeg (or scoop install ffmpeg, or choco install ffmpeg), then try again.",
    darwin: "ffmpeg is not installed. Install it once with: brew install ffmpeg, then try again.",
    other: "ffmpeg is not installed. Install it with your package manager, for example: sudo apt install ffmpeg (Debian, Ubuntu), sudo dnf install ffmpeg (Fedora) or sudo pacman -S ffmpeg (Arch), then try again.",
  },
};
const installFor = (name: HelperName, p: NodeJS.Platform): string => INSTALL[name][p === "win32" ? "win32" : p === "darwin" ? "darwin" : "other"];

function defaultRun(cmd: string, args: string[]): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    let out = "";
    let done = false;
    const finish = (code: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ code, out });
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(cmd, args, { stdio: ["ignore", "pipe", "ignore"], windowsHide: true });
    } catch {
      return resolve({ code: -1, out: "" });
    }
    const timer = setTimeout(() => {
      child.kill();
      finish(-1);
    }, 8000);
    child.stdout?.on("data", (d: Buffer) => {
      if (out.length < 2000) out += d.toString();
    });
    child.on("error", () => finish(-1));
    child.on("close", (code) => finish(code ?? -1));
  });
}

/** Where each program usually is on each system when it is not on the PATH. */
function places(name: HelperName, platform: NodeJS.Platform, env: Record<string, string | undefined>): string[] {
  const exe = name;
  if (platform === "win32") {
    const w = path.win32;
    const out: string[] = [];
    if (env.LOCALAPPDATA) out.push(w.join(env.LOCALAPPDATA, "Microsoft", "WinGet", "Links", `${exe}.exe`), w.join(env.LOCALAPPDATA, "Programs", exe, `${exe}.exe`));
    if (env.ProgramFiles) out.push(w.join(env.ProgramFiles, exe, `${exe}.exe`), w.join(env.ProgramFiles, exe, "bin", `${exe}.exe`));
    if (env.USERPROFILE) out.push(w.join(env.USERPROFILE, "scoop", "shims", `${exe}.exe`));
    out.push(`C:\\ProgramData\\chocolatey\\bin\\${exe}.exe`, `C:\\${exe}\\bin\\${exe}.exe`);
    return out;
  }
  if (platform === "darwin") return [`/opt/homebrew/bin/${exe}`, `/usr/local/bin/${exe}`];
  const out = [`/usr/bin/${exe}`, `/usr/local/bin/${exe}`, `/snap/bin/${exe}`];
  if (env.HOME) out.push(path.posix.join(env.HOME, ".local", "bin", exe));
  return out;
}

const versionOfOutput = (name: HelperName, out: string): string | null => {
  const first = out.trim().split(/\r?\n/)[0] ?? "";
  if (name === "yt-dlp") return /^\d{4}\.\d{1,2}\.\d{1,2}/.test(first) ? first.trim() : null;
  const m = /^ffmpeg version\s+(\S+)/i.exec(first);
  return m ? m[1]! : null;
};

/**
 * Finds the owner's yt-dlp or ffmpeg: the program they set, or else the name on the PATH, or else the usual places for their
 * system. Friend never installs anything: when it is not there the answer is one sentence saying how to install it.
 */
export async function findHelper(name: HelperName, d: FindHelperDeps): Promise<FindResult> {
  const platform = d.platform ?? process.platform;
  const env = d.env ?? process.env;
  const exists = d.exists ?? existsSync;
  const run = d.run ?? defaultRun;
  const isPath = (p: string) => /[\\/]/.test(p);
  const tryOne = async (p: string): Promise<FindResult | null> => {
    if (isPath(p) && !exists(p)) return null;
    const r = await run(p, [name === "ffmpeg" ? "-version" : "--version"]);
    if (r.code !== 0) return null;
    const v = versionOfOutput(name, r.out);
    return v ? { found: true, path: p, version: v } : null;
  };
  const set = d.program.trim();
  if (set) return (await tryOne(set)) ?? { found: false, install: `The program set in Settings is not ${name}, or does not start. Use ${name}, or clear the setting so Friend can look for it. ${installFor(name, platform)}` };
  for (const c of [...(d.managed ? [d.managed] : []), name, ...places(name, platform, env)]) {
    const r = await tryOne(c);
    if (r) return r;
  }
  return { found: false, install: installFor(name, platform) };
}

const asStatus = (r: FindResult): HelperStatus => (r.found ? { found: true, version: r.version, path: r.path } : { found: false, install: r.install });

/** Which of the three programs web video uses are on this PC (a look, not a change). */
export async function videoStatus(config: Pick<Config, "video" | "music">, deps: Omit<FindHelperDeps, "program" | "managed"> & { dataDir?: string } = {}): Promise<VideoStatus> {
  const { dataDir, ...find } = deps;
  const managed = (name: HelperName) => (dataDir ? managedPath(dataDir, name, deps.platform) : undefined);
  const [ytdlp, ffmpeg, mpv] = await Promise.all([
    findHelper("yt-dlp", { ...find, program: config.video.ytdlp, managed: managed("yt-dlp") }),
    findHelper("ffmpeg", { ...find, program: config.video.ffmpeg, managed: managed("ffmpeg") }),
    findMpv({ ...find, program: config.music.hostPlayer }),
  ]);
  return { ytdlp: asStatus(ytdlp), ffmpeg: asStatus(ffmpeg), mpv: asStatus(mpv) };
}
