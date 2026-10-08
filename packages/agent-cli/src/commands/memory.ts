import { Audit, Auth, Memory, openDb } from "@friend/server";
import type { IO } from "../cli";

const USAGE = "Usage: friend memory list | friend memory forget <number> | friend memory clear";

/** See and delete the notes Friend keeps about you. Clearing everything needs the owner PIN. */
export async function memoryCommand(args: string[], io: IO): Promise<number> {
  const [sub, arg] = args;
  if (sub !== "list" && sub !== "forget" && sub !== "clear") {
    io.err(USAGE);
    return 1;
  }
  const db = openDb(io.dataDir);
  try {
    const memory = new Memory(db);
    const audit = new Audit(db);

    if (sub === "list") {
      const notes = memory.list();
      if (notes.length === 0) io.out("No notes saved.");
      for (const n of notes) io.out(`#${n.id}  ${n.text}  (${n.source}, ${new Date(n.createdAt).toLocaleDateString()})`);
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
    const count = memory.count();
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
    audit.log("owner", "memory.clear", { count, via: "cli" });
    io.out(`Deleted ${count} notes.`);
    return 0;
  } finally {
    db.close();
  }
}
