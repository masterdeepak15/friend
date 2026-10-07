import { Audit, Auth, PolicyEngine, loadConfig, openDb } from "@friend/server";
import type { IO } from "../cli";

const parseId = (v: string | undefined): number | null => (v && /^\d+$/.test(v) ? Number(v) : null);

export async function rulesCommand(args: string[], io: IO): Promise<number> {
  const [sub, idArg] = args;
  const db = openDb(io.dataDir);
  try {
    const policy = new PolicyEngine(db, loadConfig(io.dataDir));
    if (sub === "list") {
      const rules = policy.listRules();
      if (rules.length === 0) io.out("No always-allow rules.");
      for (const r of rules) io.out(`#${r.id}  ${r.tool}  ${JSON.stringify(r.matcher)}`);
      return 0;
    }
    if (sub === "remove") {
      const id = parseId(idArg);
      if (id === null) {
        io.err("Usage: friend rules remove <id>");
        return 1;
      }
      policy.removeRule(id);
      new Audit(db).log("owner", "rule.removed", { id });
      io.out(`Removed rule #${id}.`);
      return 0;
    }
    io.err("Usage: friend rules list | friend rules remove <id>");
    return 1;
  } finally {
    db.close();
  }
}

export async function devicesCommand(args: string[], io: IO): Promise<number> {
  const [sub, idArg] = args;
  const db = openDb(io.dataDir);
  try {
    const auth = new Auth(db, new Audit(db));
    if (sub === "list") {
      const devices = auth.listDevices();
      if (devices.length === 0) io.out("No paired devices.");
      for (const d of devices) {
        io.out(`#${d.id}  ${d.name}  last seen ${d.lastSeen ? new Date(d.lastSeen).toLocaleString() : "never"}`);
      }
      return 0;
    }
    if (sub === "revoke") {
      const id = parseId(idArg);
      if (id === null) {
        io.err("Usage: friend devices revoke <id>");
        return 1;
      }
      auth.revokeDevice(id);
      io.out(`Revoked device #${id}. It can no longer connect.`);
      return 0;
    }
    io.err("Usage: friend devices list | friend devices revoke <id>");
    return 1;
  } finally {
    db.close();
  }
}
