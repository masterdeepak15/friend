export type TermState = "busy" | "idle" | "prompt" | "exited";
export interface TermOption {
  /** The number shown next to the option, when there is one. */
  n: number | null;
  text: string;
  /** The option the cursor is on. */
  selected: boolean;
}
export interface ScreenReading {
  state: TermState;
  options: TermOption[];
  /** The question or the command a prompt is about. */
  question: string;
  /** The prompt asks about something that cannot be undone or runs with more power. */
  destructive: boolean;
}

/** What a prompt says that is not something to answer without the owner. */
const DESTRUCTIVE =
  /\b(rm\s+-[a-z]*[rf]|rm\s+-r|del\s+\/|remove-item|rmdir|delete|drop\s+(table|database|schema)|truncate\s+table|force[- ]push|push\s+.*--force|--force\b|reset\s+--hard|git\s+clean|format\s+[a-z]:|mkfs|diskpart|sudo\b|runas|run as admin|administrator|chmod\s+777|curl\s+[^|\n]*\|\s*(ba)?sh|invoke-expression|\biex\b|npm\s+publish|overwrite|uninstall|shutdown|restart-computer|reg\s+(add|delete)|set-executionpolicy)\b/i;

const NUMBERED = /^\s*([❯>›▶➤*]\s*)?(\d{1,2})[.)]\s+(\S.*?)\s*$/;
const BULLET_SELECT = /^\s*([❯›▶➤])\s+(\S.*?)\s*$/;
const YES_NO = /\((y\/n|yes\/no)\)|\[(y\/n|Y\/n|y\/N|yes\/no)\]|press enter to continue|do you want to (proceed|continue|allow|make this edit|create|run)/i;

/** The lines of the screen without the empty ones at the end and the spaces at the right. */
export function trimScreen(lines: string[]): string[] {
  const out = lines.map((l) => l.replace(/\s+$/, ""));
  while (out.length && out[out.length - 1] === "") out.pop();
  return out;
}

/**
 * Reads a terminal screen the way a person would glance at it: is the program still working (it printed a moment ago, or says it can
 * be interrupted), is it waiting at a menu or a question (and what are the options), or is it simply waiting for the next instruction.
 */
export function readScreen(screen: string[], quietMs: number, exited: boolean): ScreenReading {
  const lines = trimScreen(screen);
  if (exited) return { state: "exited", options: [], question: "", destructive: false };
  const text = lines.join("\n");

  const options: TermOption[] = [];
  let firstOption = -1;
  for (let i = 0; i < lines.length; i++) {
    const n = NUMBERED.exec(lines[i]!);
    if (n && (n[1] || /^\s*\d/.test(lines[i]!))) {
      if (firstOption < 0) firstOption = i;
      options.push({ n: Number(n[2]), text: n[3]!, selected: !!n[1] });
    }
  }
  // a menu of plain lines with a pointer (❯ Option) and no numbers
  if (options.length < 2) {
    options.length = 0;
    firstOption = -1;
    for (let i = 0; i < lines.length; i++) {
      const b = BULLET_SELECT.exec(lines[i]!);
      if (b && !/^\s*[❯›▶➤]\s*$/.test(lines[i]!) && lines[i]!.trim().length < 100 && !lines[i]!.includes("│")) {
        if (firstOption < 0) firstOption = i;
        options.push({ n: null, text: b[2]!, selected: true });
      }
    }
    if (options.length) {
      // the pointer marks only one; the others are the lines around it
      const at = firstOption;
      options.length = 0;
      for (let i = Math.max(0, at - 3); i < Math.min(lines.length, at + 6); i++) {
        const t = lines[i]!.replace(/^\s*[❯›▶➤]?\s*/, "").trim();
        if (t && !/^[─━╭╮╰╯│]+$/.test(t) && !/[?:]$/.test(t) && t.length < 80) options.push({ n: null, text: t, selected: /^\s*[❯›▶➤]/.test(lines[i]!) });
      }
    }
  }

  const askingYesNo = YES_NO.test(text);
  const menu = options.length >= 2;
  const working = /\(esc to interrupt\)|esc to interrupt|\bthinking\b.*\(\d+s|✻|✽|✶|✳|⠋|⠙|⠹|⠸|⠼|⠴|⠦|⠧|⠇|⠏/i.test(lines.slice(-8).join("\n"));
  const recent = quietMs < 1500;

  if ((menu || askingYesNo) && !recent) {
    const from = menu ? Math.max(0, firstOption - 8) : Math.max(0, lines.length - 10);
    const block = lines.slice(from, menu ? firstOption : lines.length).filter((l) => l.trim() && !/^[─━╭╮╰╯│\s]+$/.test(l));
    const question = block.slice(-4).map((l) => l.replace(/^[│\s]+|[│\s]+$/g, "")).join(" ").trim().slice(0, 400);
    return { state: "prompt", options: menu ? options : [], question, destructive: DESTRUCTIVE.test(block.join("\n")) };
  }
  if (recent || working) return { state: "busy", options: [], question: "", destructive: false };
  return { state: "idle", options: [], question: "", destructive: false };
}

const KEYS: Record<string, string> = {
  enter: "\r",
  return: "\r",
  esc: "\x1b",
  escape: "\x1b",
  tab: "\t",
  "shift+tab": "\x1b[Z",
  backspace: "\x7f",
  space: " ",
  up: "\x1b[A",
  down: "\x1b[B",
  right: "\x1b[C",
  left: "\x1b[D",
  home: "\x1b[H",
  end: "\x1b[F",
  pageup: "\x1b[5~",
  pagedown: "\x1b[6~",
  delete: "\x1b[3~",
  insert: "\x1b[2~",
  f1: "\x1bOP",
  f2: "\x1bOQ",
  f3: "\x1bOR",
  f4: "\x1bOS",
  f5: "\x1b[15~",
  f10: "\x1b[21~",
  f12: "\x1b[24~",
};

/** The bytes a named key sends to a terminal. */
export function keyBytes(name: string): string {
  const k = name.trim().toLowerCase();
  const known = KEYS[k];
  if (known !== undefined) return known;
  const ctrl = /^ctrl\+([a-z\[\\\]])$/.exec(k);
  if (ctrl) return String.fromCharCode(ctrl[1]!.charCodeAt(0) & 0x1f);
  const alt = /^alt\+(.)$/.exec(k);
  if (alt) return `\x1b${alt[1]}`;
  if (name.length === 1) return name;
  throw new Error(`Unknown key: ${name}. Use Enter, Esc, Tab, Up, Down, Left, Right, Backspace, Delete, Home, End, PageUp, PageDown, Ctrl+C...`);
}

/** Keys that cancel or refuse: always safe to send, even at a destructive prompt. */
export function isCancel(name: string): boolean {
  return /^(esc|escape|ctrl\+c|ctrl\+d|n)$/i.test(name.trim());
}
