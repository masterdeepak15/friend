import type { PcPermissions } from "./pc";

export type Verdict = { decision: "allow" | "ask" | "deny"; reason?: string };

/** What the PC's own state is, as far as the server knows. */
export interface PcGuardState {
  /** A control session is running and not paused. */
  lease: boolean;
}

const allow = (): Verdict => ({ decision: "allow" });
const deny = (reason: string): Verdict => ({ decision: "deny", reason });
const ask = (reason: string): Verdict => ({ decision: "ask", reason });

/** Use the mouse and keyboard. */
const INPUT = new Set(["pc.click", "pc.type", "pc.scroll", "pc.move", "pc.shortcut", "pc.multi_select", "pc.multi_edit", "pc.app", "pc.clipboard", "pc.notify", "pc.wait_for"]);
/** Look at the screen. */
const LOOK = new Set(["pc.snapshot", "pc.screenshot"]);

/** The fixed list of PowerShell and Windows commands that cannot be undone or change the system. The owner may add to it; nothing removes from it. */
const CRITICAL_SHELL: RegExp[] = [
  /\b(remove-item|ri|rm|del|erase|rmdir|rd)\b/i,
  /\b(format-volume|format|clear-disk|diskpart|initialize-disk|remove-partition)\b/i,
  /\b(shutdown|restart-computer|stop-computer|logoff)\b/i,
  /\breg(\.exe)?\s+(add|delete|import|load|unload|copy|restore)\b/i,
  /\b(set|new|remove|rename|copy|move)-itemproperty\b/i,
  /\b(msiexec|winget|choco|scoop|pip|npm|dism|pnputil)\b.*\b(install|uninstall|remove|add|-i|-x|\/i|\/x)\b/i,
  /\buninstall(-package|-program)?\b/i,
  /-verb\s+runas/i,
  /\b(iex|invoke-expression)\b/i,
  /\b(irm|iwr|invoke-webrequest|invoke-restmethod|curl|wget|bitsadmin|certutil)\b.*(\||-outfile|-o\b|-urlcache)/i,
  /\b(set-executionpolicy|set-mppreference|add-mppreference|disable-windows|enable-windows|netsh|bcdedit|sc(\.exe)?\s+(delete|config|create)|schtasks\s+\/(create|delete)|net\s+user|net\s+localgroup)\b/i,
  /\b(taskkill|stop-process|kill)\b/i,
  /\bgit\s+(push\s+.*(--force|-f\b)|reset\s+--hard|clean\s+-[a-z]*f|checkout\s+--\s|branch\s+-D)/i,
  /\bnpm\s+(publish|unpublish|deprecate)\b/i,
];
/** Files that run when opened: writing one asks. */
const RUNS = /\.(exe|bat|cmd|ps1|psm1|vbs|js|jse|wsf|msi|dll|scr|lnk|reg|com|hta)$/i;

const toWin = (p: string): string => p.replace(/\//g, "\\");

/** A Windows path in one comparable form: backslashes, no `.` or `..`, lower case. Empty when the path is not absolute. */
export function normalizeWin(path: string): string {
  const m = /^([a-zA-Z]:|\\\\[^\\]+\\[^\\]+)(.*)$/.exec(toWin(path));
  if (!m) return "";
  const parts: string[] = [];
  for (const seg of m[2]!.split("\\")) {
    if (!seg || seg === ".") continue;
    if (seg === "..") parts.pop();
    else parts.push(seg.toLowerCase());
  }
  return `${m[1]!.toLowerCase()}\\${parts.join("\\")}`.replace(/\\+$/, "");
}

/** Whether a path is one of the allowed folders or inside one. Case and slash direction do not matter; `..` and look-alike names do not get out. */
export function insideFolders(path: string, folders: readonly string[]): boolean {
  const target = normalizeWin(path);
  if (!target) return false;
  return folders.some((f) => {
    const base = normalizeWin(f);
    return base !== "" && (target === base || target.startsWith(`${base}\\`));
  });
}

const needs = (what: string): string => `The owner has not given this PC the ${what} permission. They can switch it on in Settings, Windows PCs.`;
const OUTSIDE = "That is outside the folders the owner allowed for this PC.";

/**
 * Decides, from the PC's permissions alone, whether a call may go to the PC: allowed, asked about (the owner gets a card naming the
 * PC) or refused. The PC checks again with what only it can see (window titles, button names). `extra` are the owner's own patterns
 * for commands that ask.
 */
export function checkPcCall(tool: string, args: unknown, perms: PcPermissions, state: PcGuardState, extra: readonly string[]): Verdict {
  const a = (args ?? {}) as Record<string, unknown>;
  const str = (k: string): string => (typeof a[k] === "string" ? (a[k] as string) : "");

  if (tool === "pc.list" || tool === "pc.displays") return allow();
  if (tool === "pc.control") {
    if (str("action") === "start") return perms.control ? ask("Start a control session") : deny(needs("control"));
    return allow();
  }
  if (tool === "pc.tasks") return perms.control ? allow() : deny(needs("control"));

  if (LOOK.has(tool) || INPUT.has(tool)) {
    if (!perms.control) return deny(needs("control"));
    if (LOOK.has(tool) && !perms.screen) return deny(needs("screen"));
    if (!state.lease) return deny("There is no control session on this PC. Start one with pc.control (the owner is asked), then try again. If the owner used the mouse or keyboard, it paused: start it again.");
    return allow();
  }

  if (tool === "pc.shell") {
    if (!perms.shell) return deny(needs("shell"));
    const command = str("command");
    const mine = [...extra, ...(perms.askPatterns ?? [])].some((p) => safe(p, command));
    return CRITICAL_SHELL.some((r) => r.test(command)) || mine ? ask("A command that changes or removes things") : allow();
  }

  if (tool === "pc.files") {
    if (perms.files === "off") return deny(needs("files"));
    const action = str("action");
    const writes = action === "write" || action === "copy" || action === "move" || action === "delete";
    if (writes && perms.files !== "write") return deny("This PC allows reading files, not changing them.");
    for (const p of [str("path"), str("to")]) if (p && !insideFolders(p, perms.folders)) return deny(perms.folders.length === 0 ? "The owner has not chosen any folder for this PC yet." : OUTSIDE);
    if (action === "delete") return ask("Delete a file or folder");
    if ((action === "write" || action === "copy" || action === "move") && (RUNS.test(str("path")) || RUNS.test(str("to")))) return ask("Write a file that runs when opened");
    return allow();
  }

  if (tool === "pc.process") {
    if (!perms.process) return deny(needs("process"));
    return str("action") === "end" ? ask("End a program") : allow();
  }

  if (tool === "pc.registry") {
    if (!perms.registry) return deny(needs("registry"));
    return str("action") === "read" || str("action") === "list" ? allow() : ask("Change the registry");
  }

  if (tool.startsWith("pc.term.") || tool === "pc.claude.sessions") {
    if (!perms.shell) return deny(needs("shell"));
    if (tool === "pc.term.open") {
      const cwd = str("cwd");
      if (!cwd) return deny("Say which folder the terminal opens in (cwd), one of the folders the owner allowed.");
      if (!insideFolders(cwd, perms.folders)) return deny(perms.folders.length === 0 ? "The owner has not chosen any folder for this PC yet." : OUTSIDE);
      return ask("Open a terminal");
    }
    if (tool === "pc.claude.sessions" && !insideFolders(str("project"), perms.folders)) return deny(OUTSIDE);
    return allow();
  }

  return deny("This tool is not available for a PC.");
}

function safe(pattern: string, text: string): boolean {
  try {
    return new RegExp(pattern, "i").test(text);
  } catch {
    return false; // a pattern that is not valid is ignored
  }
}
