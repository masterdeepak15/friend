import { spawn } from "node:child_process";
import type { SelfCommand } from "./autostart";

/** Filled in when the program is bundled for npm. */
declare const __FRIEND_VERSION__: string | undefined;

export const PACKAGE = "friend-assistant";

/** The version of Friend that is running, or "development" when it runs from the source code. */
export const runningVersion = (): string => (typeof __FRIEND_VERSION__ === "string" ? __FRIEND_VERSION__ : "development");

/** The newest version on npm's registry, or null when it could not be asked (no internet, a slow answer, nonsense). */
export async function npmLatest(fetchFn: typeof fetch = fetch, timeoutMs = 10_000): Promise<string | null> {
  try {
    const res = await fetchFn(`https://registry.npmjs.org/${PACKAGE}/latest`, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const v = ((await res.json()) as { version?: unknown }).version;
    return typeof v === "string" && /^\d+\.\d+\.\d+$/.test(v) ? v : null;
  } catch {
    return null;
  }
}

/** PowerShell single-quoted string. */
const ps = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * Starts `friend upgrade --auto` as a program of its own, apart from this one: the upgrade stops this Friend, installs the new
 * version and starts Friend again, so it must not die with it. On Windows, stopping Friend ends everything it started, so the
 * upgrade is started through PowerShell, which leaves it without a parent to be ended with.
 */
export function spawnUpgrade(self: SelfCommand, platform: NodeJS.Platform = process.platform): boolean {
  if (!self.node || !self.script) return false;
  try {
    const child =
      platform === "win32"
        ? spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", `Start-Process -WindowStyle Hidden -FilePath ${ps(self.node)} -ArgumentList ${ps(`"${self.script}"`)},'upgrade','--auto'`], { detached: true, stdio: "ignore", windowsHide: true })
        : spawn(self.node, [self.script, "upgrade", "--auto"], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
    return child.pid !== undefined;
  } catch {
    return false;
  }
}
