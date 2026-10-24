import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Memory } from "../memory";
import { MemoryTree, inboxName } from "./tree";

const MARKER = ".imported-notes";

/**
 * Brings the older flat list of notes into the tree once, one small note each in inbox/, oldest first. The table is left as it was, so
 * nothing is lost if the owner turns the tree off. Returns how many notes came over.
 */
export function importFlatNotes(memory: Memory, tree: MemoryTree): number {
  tree.ensure();
  const marker = join(tree.root, MARKER);
  if (existsSync(marker)) return 0;
  let n = 0;
  for (const m of [...memory.list()].reverse()) {
    const name = inboxName(m.text, (x) => tree.has(`inbox/${x}.md`));
    const r = tree.write(`inbox/${name}.md`, m.text, { title: m.text.slice(0, 60), summary: m.text.slice(0, 120), source: "import", ...(n === 0 ? { folderSummary: "quick notes not filed yet, and notes brought over from the older list" } : {}) });
    if (r.ok) n++;
  }
  writeFileSync(marker, new Date().toISOString());
  return n;
}
