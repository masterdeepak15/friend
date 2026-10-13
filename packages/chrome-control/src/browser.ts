import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { rmSync, writeFileSync } from "node:fs";

/**
 * Chrome shows "<extension> started debugging this browser" with a Cancel button whenever an extension uses the debugger.
 * This flag hides it, but only a browser that is STARTED with it: a shortcut with the flag does nothing while Chrome is
 * already running (it just opens a window in the running Chrome). So three things are needed: the flag on the shortcuts,
 * a way to see whether the running Chrome has it, and a way to restart Chrome with it.
 */
export const DEBUG_FLAG = "--silent-debugger-extension-api";

const WIN = process.platform === "win32";
const MAC = process.platform === "darwin";

export const hasFlag = (cmd: string): boolean => new RegExp(`(^|\\s)${DEBUG_FLAG}(=\\S*)?(\\s|$)`).test(cmd);

/** The browser itself, not one of its helper processes (renderer, gpu, utility ...). */
export const isMainProcess = (cmd: string): boolean => !/(^|\s)--type=/.test(cmd);

export function describeMains(cmds: string[]): { running: boolean; hidden: boolean | null } {
  const mains = cmds.filter(isMainProcess);
  if (!mains.length) return { running: false, hidden: null };
  return { running: true, hidden: mains.every(hasFlag) };
}

export function patchArguments(args: string): { args: string; changed: boolean } {
  if (hasFlag(args)) return { args, changed: false };
  return { args: `${args} ${DEBUG_FLAG}`.trim(), changed: true };
}

/** Windows: PowerShell that visits the shortcuts to Chrome, Edge and Brave (desktop, Start menu, taskbar). `patch` adds the flag; otherwise it only looks. */
export function shortcutScript(patch: boolean): string {
  return [
    `$flag = '${DEBUG_FLAG}'`,
    "$dirs = @([Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'),",
    "  [Environment]::GetFolderPath('Programs'), [Environment]::GetFolderPath('CommonPrograms'),",
    "  (Join-Path $env:APPDATA 'Microsoft\\Internet Explorer\\Quick Launch\\User Pinned\\TaskBar')) | Where-Object { $_ -and (Test-Path $_) }",
    "$sh = New-Object -ComObject WScript.Shell",
    "foreach ($d in $dirs) { Get-ChildItem -Path $d -Filter *.lnk -Recurse -ErrorAction SilentlyContinue | ForEach-Object {",
    "  try { $l = $sh.CreateShortcut($_.FullName)",
    "    if ($l.TargetPath -match '(chrome|msedge|brave)\\.exe$') {",
    patch
      ? "      if ($l.Arguments -notlike \"*$flag*\") { $l.Arguments = ($l.Arguments + ' ' + $flag).Trim(); $l.Save(); Write-Output ('patched|' + $_.FullName) }"
      : "      if ($l.Arguments -notlike \"*$flag*\") { Write-Output ('none|' + $_.FullName) }",
    patch ? "      else { Write-Output ('already|' + $_.FullName) } } } catch { Write-Output ('failed|' + $_.FullName) } } }" : "      else { Write-Output ('has|' + $_.FullName) } } } catch { Write-Output ('failed|' + $_.FullName) } } }",
  ].join("\n");
}

export interface ShortcutCounts {
  patched: number;
  already: number;
  failed: number;
  /** Shortcuts that have the flag now. */
  withFlag: number;
  total: number;
}

export function parseShortcutRows(out: string): ShortcutCounts {
  const rows = out
    .split(/\r?\n/)
    .map((l) => l.split("|")[0]!.trim())
    .filter(Boolean);
  const n = (k: string) => rows.filter((r) => r === k).length;
  const c = { patched: n("patched"), already: n("already"), failed: n("failed"), has: n("has"), none: n("none") };
  return { patched: c.patched, already: c.already, failed: c.failed, withFlag: c.patched + c.already + c.has, total: c.patched + c.already + c.failed + c.has + c.none };
}

function powershell(script: string): string {
  const f = join(tmpdir(), `chrome-control-${process.pid}-${Date.now()}.ps1`);
  writeFileSync(f, script);
  try {
    const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", f], { encoding: "utf8" });
    return String(r.stdout || "");
  } finally {
    rmSync(f, { force: true });
  }
}

/** The command lines of Chrome's processes (all of them: the caller picks the main ones). */
export function chromeCommandLines(): string[] {
  if (WIN) {
    return powershell("Get-CimInstance Win32_Process -Filter \"Name='chrome.exe'\" | ForEach-Object { $_.CommandLine }")
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter(Boolean);
  }
  const r = spawnSync("ps", ["-eo", "args"], { encoding: "utf8" });
  return String(r.stdout || "")
    .split("\n")
    .filter((l) => /(^|\/)(google-chrome(-stable)?|chromium(-browser)?|Google Chrome)(\s|$)/.test(l.trim().split(/\s--/)[0]!));
}

const LINUX_LAUNCHERS = ["google-chrome.desktop", "microsoft-edge.desktop", "brave-browser.desktop", "chromium.desktop"];
const linuxDir = () => join(homedir(), ".local", "share", "applications");

/** Linux: user-level copies of the .desktop launchers with the flag added. */
function patchLinux(): ShortcutCounts {
  const counts: ShortcutCounts = { patched: 0, already: 0, failed: 0, withFlag: 0, total: 0 };
  for (const name of LINUX_LAUNCHERS) {
    const src = [linuxDir(), "/usr/share/applications", "/var/lib/snapd/desktop/applications"].map((d) => join(d, name)).find(existsSync);
    if (!src) continue;
    const text = readFileSync(src, "utf8");
    counts.total++;
    if (text.includes(DEBUG_FLAG)) {
      counts.already++;
      continue;
    }
    try {
      const out = text.replace(/^(Exec=.*)$/gm, (l) => (l.includes(DEBUG_FLAG) ? l : l.replace(/(Exec=\S+)/, `$1 ${DEBUG_FLAG}`)));
      writeFileSync(join(linuxDir(), name), out);
      counts.patched++;
    } catch {
      counts.failed++;
    }
  }
  counts.withFlag = counts.patched + counts.already;
  return counts;
}

/** How many Chrome shortcuts have the flag, or null where there is nothing to count (macOS). */
export function countShortcuts(): ShortcutCounts | null {
  if (WIN) return parseShortcutRows(powershell(shortcutScript(false)));
  if (MAC) return null;
  const total = LINUX_LAUNCHERS.filter((n) => [linuxDir(), "/usr/share/applications"].some((d) => existsSync(join(d, n)))).length;
  const withFlag = LINUX_LAUNCHERS.filter((n) => existsSync(join(linuxDir(), n)) && readFileSync(join(linuxDir(), n), "utf8").includes(DEBUG_FLAG)).length;
  return { patched: 0, already: 0, failed: 0, withFlag, total };
}

/** Adds the flag to the shortcuts. Shortcuts in shared folders may need an administrator: they are counted as failed. */
export function patchShortcuts(): ShortcutCounts | null {
  if (WIN) return parseShortcutRows(powershell(shortcutScript(true)));
  if (MAC) return null;
  return patchLinux();
}

export interface FlagStatus {
  platform: NodeJS.Platform;
  running: boolean;
  /** The running Chrome was started with the flag. Null when Chrome is not running. */
  hidden: boolean | null;
  shortcuts: ShortcutCounts | null;
}

export function flagStatus(): FlagStatus {
  return { platform: process.platform, ...describeMains(chromeCommandLines()), shortcuts: countShortcuts() };
}

function chromeExe(): string | null {
  const cands = WIN
    ? [join(process.env.PROGRAMFILES ?? "", "Google", "Chrome", "Application", "chrome.exe"), join(process.env["PROGRAMFILES(X86)"] ?? "", "Google", "Chrome", "Application", "chrome.exe"), join(process.env.LOCALAPPDATA ?? "", "Google", "Chrome", "Application", "chrome.exe")]
    : MAC
      ? ["/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"]
      : ["/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/bin/chromium"];
  return cands.find(existsSync) ?? null;
}

/** Starts Chrome with the flag. Does nothing useful while Chrome is already running (the running one keeps its own flags). */
export function startChrome(extra: string[] = []): void {
  const exe = chromeExe();
  if (!exe) throw new Error("Chrome was not found. Start it yourself with the flag " + DEBUG_FLAG);
  spawn(exe, [DEBUG_FLAG, ...extra], { detached: true, stdio: "ignore" }).unref();
}

const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Closes Chrome the polite way (every window is asked to close, so Chrome can ask about anything unsaved), waits, and starts it
 * again with the flag and the tabs back. It never kills a Chrome that still has a window open.
 */
export async function restartChrome(): Promise<{ ok: boolean; message: string }> {
  const lines = chromeCommandLines();
  if (describeMains(lines).running) {
    if (WIN) {
      powershell("Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | ForEach-Object { [void]$_.CloseMainWindow() }");
      const windowsOpen = () => powershell("(Get-Process chrome -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Measure-Object).Count").trim() !== "0";
      for (let i = 0; i < 20 && windowsOpen(); i++) await wait(500);
      if (windowsOpen()) return { ok: false, message: "Chrome did not close (it may be asking you to save something). Close it yourself, then press Start." };
      // no window is left: what remains is Chrome's background part, which keeps the old flags alive
      powershell("Get-Process chrome -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue");
      await wait(800);
    } else {
      return { ok: false, message: "Close Chrome yourself (all its windows), then press Start." };
    }
  }
  try {
    startChrome(["--restore-last-session"]);
  } catch (e) {
    return { ok: false, message: (e as Error).message };
  }
  return { ok: true, message: "Chrome was restarted with the banner hidden. Your tabs come back." };
}
