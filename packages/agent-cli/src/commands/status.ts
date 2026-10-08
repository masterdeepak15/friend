import { Audit, Auth, loadConfig, openDb } from "@friend/server";
import type { IO } from "../cli";
import { urlsFor } from "./lan";

export async function statusCommand(io: IO): Promise<number> {
  const cfg = loadConfig(io.dataDir);
  const db = openDb(io.dataDir);
  const auth = new Auth(db, new Audit(db));
  const owner = auth.hasOwner() ? `yes (${auth.assistantName()})` : "no, run: friend onboard";
  db.close();
  io.out(`Data folder:  ${cfg.dataDir}`);
  io.out(`Owner set up: ${owner}`);
  io.out(`Listens on:   ${cfg.bind}:${cfg.port}`);
  for (const n of urlsFor(cfg.bind, cfg.port, undefined, cfg.https).network) io.out(`Network URL:  ${n}`);
  io.out(`Public URL:   ${cfg.publicUrl ?? "(none)"}`);
  io.out(`Workspace:    ${cfg.roots.length ? cfg.roots.join(", ") : "(none, every file action asks first)"}`);
  io.out(`Model:        ${cfg.model}`);
  io.out(`API key:      ${cfg.apiKey || process.env.FRIEND_ANTHROPIC_KEY ? "set" : "not set"}`);
  return 0;
}
