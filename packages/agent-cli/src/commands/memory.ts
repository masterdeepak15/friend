import { Audit, Auth, Memory, MemoryTree, openDb } from "@friend/server";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { IO } from "../cli";

const USAGE = "Usage: friend memory list | friend memory show <path> | friend memory forget <path or number> | friend memory clear";

/** See and delete the notes Friend keeps about you. Clearing everything needs the owner PIN. */
export async function memoryCommand(args: string[], io: IO): Promise<number> {
  const [sub, arg] = args;
  if (sub !== "list" && sub !== "show" && sub !== "forget" && sub !== "clear") {
    io.err(USAGE);
    return 1;
  }
  const db = openDb(io.dataDir);
  try {
    const memory = new Memory(db);
    const audit = new Audit(db);
    // once Friend has made its memory tree there is a memory/ folder with an INDEX.md; before that, the older numbered list is all there is
    const tree = existsSync(join(io.dataDir, "memory", "INDEX.md")) ? new MemoryTree(join(io.dataDir, "memory")) : null;

    if (sub === "show") {
      if (!tree || !arg) {
        io.err(tree ? USAGE : "There is no memory tree yet.");
        return 1;
      }
      const r = tree.read(arg);
      if (!r.ok) {
        io.err(r.error);
        return 1;
      }
      io.out(r.text);
      return 0;
    }

    if (sub === "list" && tree) {
      const o = tree.outline();
      if (o.length === 0) io.out("No notes saved.");
      for (const e of o) io.out(`${"  ".repeat(e.depth)}${e.path}  ${e.title}${e.summary ? ` — ${e.summary}` : ""}`);
      io.out(`${tree.count()} notes. Open one with: friend memory show <path>`);
      return 0;
    }

    if (sub === "list") {
      const notes = memory.list();
      if (notes.length === 0) io.out("No notes saved.");
      for (const n of notes) io.out(`#${n.id}  ${n.text}  (${n.source}, ${new Date(n.createdAt).toLocaleDateString()})`);
      return 0;
    }

    if (sub === "forget" && tree && arg && !/^\d+$/.test(arg)) {
      const r = tree.remove(arg);
      if (!r.ok) {
        io.err(r.error);
        return 1;
      }
      audit.log("owner", "memory.forget", { path: arg.slice(0, 200), removed: r.removed, via: "cli" });
      io.out(`Forgot ${r.removed} note${r.removed === 1 ? "" : "s"}.`);
      return 0;
    }

    if (sub === "forget") {
      const id = Number(arg);
      if (!arg || !Number.isInteger(id) || id < 1) {
        io.err(USAGE);
        return 1;
      }
      if (!memory.forget(id)) {
        io.err(`There is no note #${id}.`);
        return 1;
      }
      audit.log("owner", "memory.forget", { id, via: "cli" });
      io.out(`Forgot note #${id}.`);
      return 0;
    }

    // clear
    const count = memory.count() + (tree ? tree.count() : 0);
    if (count === 0) {
      io.out("No notes saved.");
      return 0;
    }
    const pin = await io.ask("Owner PIN: ", { hidden: true });
    let ok = false;
    try {
      ok = await new Auth(db, audit).verifyPin(pin.trim(), "cli");
    } catch (e) {
      io.err((e as Error).message);
      return 1;
    }
    if (!ok) {
      io.err("Incorrect PIN. Your notes were kept.");
      return 1;
    }
    memory.clear();
    tree?.clearAll();
    audit.log("owner", "memory.clear", { count, via: "cli" });
    io.out(`Deleted ${count} notes.`);
    return 0;
  } finally {
    db.close();
  }
}
