import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { looksSecret, parseNote, SOUL_PATH, type MemoryTree, type Result } from "./tree";

/** The longest a soul may be: it is sent with every request, so it is kept short. */
export const MAX_SOUL_CHARS = 3000;

/**
 * Who the assistant is when the owner has not written anything: the character the system prompt always described, now as plain text the owner can
 * change by talking. The name is a setting of its own and the safety rules stay in the prompt, so neither is part of the soul.
 */
export const DEFAULT_SOUL = `# Soul

## Purpose
You are the personal assistant of one person, your owner. You live on their PC, know their world through memory, and act for them with the tools you are given. You exist to make their day easier: answer, remind, find, show and do.

## Character
Loyal, calm and warm, like a good friend who is also very capable. Direct and honest: you say plainly when you do not know or cannot do something, and you never invent facts or numbers.

## Manner
- Short, natural sentences, written to be spoken aloud. No lectures, no filler.
- Act, do not announce: do the thing, then say in a sentence what you did.
- Show answers on the screen when they are information, numbers, plans or comparisons, and say one or two short lines about them.
- Ask a question only when you cannot go on without the answer.
- Say what you are about to do before something that changes things.

## Language
Answer in the language your owner speaks to you: English, Hindi, Marathi or a mix.

## About you
Gender: not set. Follow the voice you speak with.
How you address your owner: by name when you know it, otherwise simply "you".
`;

export interface SoulVersion {
  at: number;
  chars: number;
}

/**
 * The assistant's soul: a note at the root of memory (soul.md) that says who it is. It is read into the system prompt on every owner turn.
 * Memory's own tools cannot change it; only set and restore can, and the tools that call them ask the owner for their PIN. Every change keeps
 * the text it replaced, so a few earlier versions can be brought back.
 */
export class Soul {
  constructor(
    private tree: MemoryTree,
    private historyDir: string,
    private keep = 8,
    private clock: () => number = Date.now,
  ) {}

  /** Writes the default soul when there is none yet. */
  ensure(): void {
    if (!this.stored()) this.save(DEFAULT_SOUL, "import");
  }

  private stored(): string | null {
    this.tree.ensure();
    const r = this.tree.read(SOUL_PATH);
    if (!r.ok || r.kind !== "note") return null;
    const body = parseNote(r.text, "Soul").body.trim();
    return body || null;
  }

  /** The soul as it is now (the default when nothing is saved or memory cannot be read). */
  text(): string {
    try {
      return this.stored() ?? DEFAULT_SOUL.trim();
    } catch {
      return DEFAULT_SOUL.trim();
    }
  }

  isDefault(): boolean {
    return this.text().trim() === DEFAULT_SOUL.trim();
  }

  private save(text: string, source: "owner" | "agent" | "import"): Result {
    const r = this.tree.write(SOUL_PATH, text, { title: "Soul", summary: "Who I am: my purpose, character and manner", source: source === "agent" ? "agent" : source === "owner" ? "owner" : "import", soul: true });
    return r.ok ? { ok: true } : r;
  }

  private files(): string[] {
    if (!existsSync(this.historyDir)) return [];
    return readdirSync(this.historyDir).filter((f) => /^\d+\.md$/.test(f)).sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
  }

  /** Earlier versions, newest first. */
  versions(): SoulVersion[] {
    return this.files()
      .reverse()
      .map((f) => ({ at: parseInt(f, 10), chars: readFileSync(join(this.historyDir, f), "utf8").length }));
  }

  private remember(text: string): void {
    mkdirSync(this.historyDir, { recursive: true });
    const files = this.files();
    let at = this.clock();
    const last = files.length ? parseInt(files[files.length - 1]!, 10) : 0;
    if (at <= last) at = last + 1;
    writeFileSync(join(this.historyDir, `${at}.md`), text);
    for (const old of this.files().slice(0, -this.keep)) rmSync(join(this.historyDir, old), { force: true });
  }

  /** Replaces the soul with `raw` (kept as the earlier version of what it replaced). */
  set(raw: unknown, by: "owner" | "agent"): Result<{ chars: number }> {
    if (typeof raw !== "string" || !raw.trim()) return { ok: false, error: "A soul cannot be empty. Use restore to go back to the default." };
    const text = raw.replace(/\r\n/g, "\n").trim();
    if (text.length > MAX_SOUL_CHARS) return { ok: false, error: `That soul is too long (${text.length} characters; the limit is ${MAX_SOUL_CHARS}). Keep it short: it is read on every request.` };
    if (looksSecret(text)) return { ok: false, error: "That looks like a password, a PIN, a key or a code. A soul does not keep those." };
    const before = this.stored();
    if (before === text) return { ok: true, chars: text.length };
    const r = this.save(text, by);
    if (!r.ok) return r;
    if (before) this.remember(before);
    return { ok: true, chars: text.length };
  }

  /** Brings back the version before this one, or the default. */
  restore(to: "previous" | "default", by: "owner" | "agent"): Result<{ chars: number }> {
    if (to === "default") return this.set(DEFAULT_SOUL, by);
    const newest = this.files().pop();
    if (!newest) return { ok: false, error: "There is no earlier version of the soul." };
    const file = join(this.historyDir, newest);
    const text = readFileSync(file, "utf8");
    const r = this.set(text, by);
    if (r.ok) rmSync(file, { force: true }); // it is the current soul again; the one it replaced was kept by set
    return r;
  }
}
