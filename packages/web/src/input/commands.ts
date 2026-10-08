export interface SlashCommand {
  /** Without the slash, lowercase: "settings". */
  name: string;
  description: string;
  /** Shown after the name when the command takes an argument, such as "on|off". */
  usage?: string;
  /** Runs on this screen; never goes to the AI model. */
  run(args: string): void;
}

export interface Slash {
  commands: SlashCommand[];
  /** Runs a typed line that starts with a slash, and says so on screen when it is not a command. */
  run(text: string): void;
}

/** `/camera on` becomes { name: "camera", args: "on" }. Not a command at all unless it starts with exactly one slash. */
export function parseSlash(text: string): { name: string; args: string } | null {
  const t = text.trimStart();
  if (!t.startsWith("/") || t.startsWith("//")) return null;
  const m = /^\/(\S*)\s*(.*)$/s.exec(t);
  if (!m) return null;
  return { name: m[1]!.toLowerCase(), args: m[2]!.trim() };
}

/** What the list under the command bar offers for what has been typed so far. */
export function filterCommands(commands: SlashCommand[], text: string): SlashCommand[] {
  const p = parseSlash(text);
  if (!p) return [];
  const typedArgs = /^\/\S*\s/.test(text.trimStart());
  if (typedArgs) return commands.filter((c) => c.name === p.name); // already chosen: keep its usage in view
  const starts = commands.filter((c) => c.name.startsWith(p.name));
  const inside = commands.filter((c) => !c.name.startsWith(p.name) && c.name.includes(p.name));
  return [...starts, ...inside];
}

export function runSlash(commands: SlashCommand[], text: string, notify: (text: string) => void): void {
  const p = parseSlash(text);
  if (!p) return;
  const found = commands.find((c) => c.name === p.name);
  if (!found) {
    notify(p.name ? `There is no command /${p.name}. Type /help to see them.` : "Type /help to see the commands.");
    return;
  }
  found.run(p.args);
}

/** The text that is sent to the AI: a line with two slashes loses one, so a path like //server/share can still be said. */
export const unescapeSlash = (text: string): string => (text.trimStart().startsWith("//") ? text.trimStart().slice(1) : text);
