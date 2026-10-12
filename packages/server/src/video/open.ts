import { spawn as nodeSpawn } from "node:child_process";

/** Friend's own video address on this PC with its ticket: the only thing this will ever open. */
const OWN = /^https?:\/\/127\.0\.0\.1:\d{1,5}\/api\/video\/[0-9a-f]{32}\?o=[0-9a-f]{32}$/;

export interface OpenDeps {
  spawn?: typeof nodeSpawn;
  platform?: NodeJS.Platform;
}

/**
 * Opens a video in the PC's browser, with the system's own opener (start, open or xdg-open). It only ever opens the address Friend
 * made for the video (checked here again), so whatever the assistant is told, no other address or program can be started this way.
 */
export async function openInBrowser(url: string, d: OpenDeps = {}): Promise<boolean> {
  if (!OWN.test(url)) return false;
  const platform = d.platform ?? process.platform;
  const [cmd, args]: [string, string[]] = platform === "win32" ? ["cmd", ["/c", "start", "", url]] : platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
  try {
    const child = (d.spawn ?? nodeSpawn)(cmd, args, { stdio: "ignore", detached: true, windowsHide: true });
    child.on?.("error", () => {});
    child.unref?.();
    return true;
  } catch {
    return false;
  }
}
