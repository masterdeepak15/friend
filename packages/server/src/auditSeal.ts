import { Audit } from "./audit";
import type { Db } from "./db";

const SEAL = /^Friend audit seal (\d{4}-\d{2}-\d{2}): rows 1-(\d+), hash ([0-9a-f]{64})$/;

/** One line that says how far the log had got and the fingerprint of its last entry: sent to the owner's phone once a day. */
export const sealText = (date: string, lastId: number, hash: string): string => `Friend audit seal ${date}: rows 1-${lastId}, hash ${hash}`;

export function parseSeal(text: string): { date: string; lastId: number; hash: string } | null {
  const m = SEAL.exec(text.trim());
  if (!m || Number(m[2]) < 1) return null;
  return { date: m[1]!, lastId: Number(m[2]), hash: m[3]! };
}

export const localDate = (d: Date): string => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const localTime = (d: Date): string => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/**
 * Whether a seal written earlier still matches the log: the chain must be whole, and the entry at that place must have that hash.
 * An entry that was pruned is vouched for by its checkpoint (only the last entry of a pruned range, whose hash the checkpoint keeps).
 */
export function verifySeal(db: Db, text: string): { ok: true } | { ok: false; reason: string } {
  const s = parseSeal(text);
  if (!s) return { ok: false, reason: "That is not an audit seal." };
  const chain = new Audit(db).verify();
  if (!chain.ok) return { ok: false, reason: `The chain is broken at entry ${chain.brokenAt} (${chain.reason}).` };
  const row = db.prepare("select hash from audit_log where id = ? and legacy = 0").get(s.lastId) as { hash: string } | undefined;
  if (row) return row.hash === s.hash ? { ok: true } : { ok: false, reason: `Entry ${s.lastId} has a different fingerprint than the seal: the log was rewritten.` };
  const checkpoints = (db.prepare("select detail_json from audit_log where kind = 'audit.prune'").all() as { detail_json: string }[]).map((r) => JSON.parse(r.detail_json) as { fromId?: number; toId?: number; finalHash?: string });
  const covering = checkpoints.find((c) => typeof c.fromId === "number" && typeof c.toId === "number" && s.lastId >= c.fromId && s.lastId <= c.toId);
  if (covering) return s.lastId === covering.toId && covering.finalHash === s.hash ? { ok: true } : { ok: false, reason: `Entry ${s.lastId} was pruned (archived) and cannot be checked here; check it against the archive.` };
  return { ok: false, reason: `Entry ${s.lastId} is not in the log: entries were removed.` };
}

/** Writes today's seal into the log and tries to send it; never throws. `send` resolves with the way it went (telegram, whatsapp, sms) or null. */
export async function sealNow(d: { db: Db; audit: Audit; send: (text: string) => Promise<string | null>; now: number }): Promise<{ sent: boolean }> {
  const last = d.audit.last();
  if (!last) return { sent: false };
  const date = localDate(new Date(d.now));
  const text = sealText(date, last.id, last.hash);
  let via: string | null = null;
  try {
    via = await d.send(text);
  } catch {
    via = null;
  }
  try {
    d.audit.record({ kind: "audit.seal", actorKind: "system", outcome: via ? "done" : "failed", detail: { date, lastId: last.id, hash: last.hash, seal: text, via } });
  } catch {
    // the seal went out; the note of it can wait for the next one
  }
  return { sent: via !== null };
}

/** Once a day, from the set time on; never when the seal is off (an empty time). */
export function sealDue(now: Date, sealAt: string, lastSealDate: string | null): boolean {
  if (!sealAt) return false;
  return localTime(now) >= sealAt && lastSealDate !== localDate(now);
}
