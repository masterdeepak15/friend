import { Audit, Auth, loadConfig, openDb } from "@friend/server";
import type { IO } from "../cli";

export async function pairCommand(io: IO): Promise<number> {
  const cfg = loadConfig(io.dataDir);
  const db = openDb(io.dataDir);
  try {
    const auth = new Auth(db, new Audit(db));
    if (!auth.hasOwner()) {
      io.err("Run `friend setup` first.");
      return 1;
    }
    const code = auth.createPairCode();
    const url = cfg.publicUrl ? cfg.publicUrl.replace(/^http/, "ws") : `ws://<this-pc-address>:${cfg.port}`;
    io.out(`Pairing code: ${code}   (valid for 5 minutes, one use)`);
    io.out("On the other PC run:");
    io.out(`  friend node --url ${url.replace(/\/$/, "")}/device --code ${code}`);
    return 0;
  } finally {
    db.close();
  }
}
