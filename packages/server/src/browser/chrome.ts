import { existsSync, statSync } from "node:fs";
import { posix, win32 } from "node:path";

interface Where {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  /** Whether a file is there (tests replace it). */
  isFile?: (path: string) => boolean;
}

const fileThere = (p: string): boolean => {
  try {
    return existsSync(p) && statSync(p).isFile();
  } catch {
    return false;
  }
};

const LINUX_NAMES = ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "microsoft-edge", "microsoft-edge-stable"];
const MAC_PATHS = ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge"];

/**
 * The Chrome (or Chromium, or Edge) program on this PC, which the safe browser drives with its own private profile. An address the
 * owner chose is used as it is and nothing else is tried: if it is wrong, they should hear that, not get a different browser.
 */
export function findChrome(override = "", w: Where = {}): string | null {
  const platform = w.platform ?? process.platform;
  const env = w.env ?? process.env;
  const isFile = w.isFile ?? fileThere;
  const join = platform === "win32" ? win32.join : posix.join;
  if (override.trim()) return isFile(override.trim()) ? override.trim() : null;
  if (platform === "win32") {
    const roots = [env.PROGRAMFILES, env["PROGRAMFILES(X86)"], env.LOCALAPPDATA].filter((r): r is string => !!r);
    for (const r of roots) for (const rel of ["Google/Chrome/Application/chrome.exe", "Chromium/Application/chrome.exe", "Microsoft/Edge/Application/msedge.exe"]) if (isFile(join(r, rel))) return join(r, rel);
    return null;
  }
  if (platform === "darwin") return MAC_PATHS.find(isFile) ?? null;
  for (const dir of (env.PATH ?? "").split(":").filter(Boolean)) for (const name of LINUX_NAMES) if (isFile(join(dir, name))) return join(dir, name);
  return null;
}
