import type { IO } from "../../cli";

export interface Ui {
  io: IO;
  /** Take the suggested answer to every question except secrets. */
  yes: boolean;
}

export interface Option<K extends string = string> {
  key: K;
  label: string;
  hint?: string;
}

const TRIES = 3;

/** What was typed, matched to an option by its number, its name as shown (or the first word of it), or its key. */
function pick<K extends string>(options: Option<K>[], typed: string): Option<K> | undefined {
  const a = typed.trim().toLowerCase();
  if (/^\d+$/.test(a)) return options[Number(a) - 1];
  return options.find((o) => o.key.toLowerCase() === a || o.label.toLowerCase() === a || o.label.toLowerCase().split(/\s+/)[0] === a);
}

export function heading(ui: Ui, n: number, total: number, title: string): void {
  ui.io.out("");
  ui.io.out(`── Step ${n} of ${total} · ${title} ${"─".repeat(Math.max(2, 52 - title.length))}`);
}

/** One answer from a numbered list. Enter takes the suggestion; a number or the name works. */
export async function choose<K extends string>(ui: Ui, question: string, options: Option<K>[], suggested: K): Promise<K> {
  const { io } = ui;
  const at = Math.max(0, options.findIndex((o) => o.key === suggested));
  io.out(question);
  options.forEach((o, i) => io.out(`  ${i + 1}) ${o.label}${o.hint ? `  (${o.hint})` : ""}${i === at ? "   <- suggested" : ""}`));
  if (ui.yes) return options[at]!.key;
  for (let t = 0; t < TRIES; t++) {
    const a = (await io.ask(`Choose 1-${options.length} [${at + 1}]: `)).trim().toLowerCase();
    if (!a) return options[at]!.key;
    const hit = pick(options, a);
    if (hit) return hit.key;
    io.out(`"${a}" is not one of the choices.`);
  }
  io.out(`Taking the suggested choice: ${options[at]!.label}.`);
  return options[at]!.key;
}

/** Several answers from a numbered list: "1,3", "all" or "none". Enter takes the suggestions. */
export async function chooseMany<K extends string>(ui: Ui, question: string, options: Option<K>[], suggested: K[]): Promise<K[]> {
  const { io } = ui;
  io.out(question);
  options.forEach((o, i) => io.out(`  ${i + 1}) ${o.label}${o.hint ? `  (${o.hint})` : ""}${suggested.includes(o.key) ? "   <- suggested" : ""}`));
  if (ui.yes) return suggested;
  const defaults = options.map((o, i) => (suggested.includes(o.key) ? i + 1 : 0)).filter(Boolean).join(",");
  for (let t = 0; t < TRIES; t++) {
    const a = (await io.ask(`Choose, separated by commas [${defaults || "none"}]: `)).trim().toLowerCase();
    if (!a) return suggested;
    if (a === "all") return options.map((o) => o.key);
    if (a === "none") return [];
    const picks = a.split(/[\s,]+/).filter(Boolean);
    const keys: K[] = [];
    let bad: string | null = null;
    for (const p of picks) {
      const o = pick(options, p);
      if (o) {
        if (!keys.includes(o.key)) keys.push(o.key);
      } else bad = p;
    }
    if (!bad) return options.map((o) => o.key).filter((k) => keys.includes(k));
    io.out(`"${bad}" is not one of the choices.`);
  }
  io.out("Taking the suggested choices.");
  return suggested;
}

export async function yesNo(ui: Ui, question: string, suggested: boolean): Promise<boolean> {
  if (ui.yes) return suggested;
  for (let t = 0; t < TRIES; t++) {
    const a = (await ui.io.ask(`${question} [${suggested ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
    if (!a) return suggested;
    if (["y", "yes", "j", "ja", "1"].includes(a)) return true;
    if (["n", "no", "0"].includes(a)) return false;
    ui.io.out('Please answer y or n.');
  }
  return suggested;
}

/** Text, with a suggestion shown in brackets that Enter accepts. */
export async function text(ui: Ui, question: string, suggested = ""): Promise<string> {
  if (ui.yes) return suggested;
  const a = (await ui.io.ask(suggested ? `${question} [${suggested}]: ` : `${question}: `)).trim();
  return a || suggested;
}
