import { NO_PC_PERMISSIONS, PcPermissions, PcStatus } from "@friend/protocol";
import { randomBytes } from "node:crypto";
import type { Db } from "../db";

export interface Pc {
  id: number;
  name: string;
  os: string;
  host: string;
  permissions: PcPermissions;
  status: PcStatus | null;
  createdAt: number;
  lastSeen: number;
  revoked: boolean;
}

/** An enrollment id that nobody used for this long stops working. */
export const ENROLLMENT_TTL_MS = 24 * 3600_000;

interface Row {
  id: number;
  name: string;
  os: string;
  host: string;
  perms_json: string;
  status_json: string;
  created_at: number;
  last_seen: number;
  revoked: number;
}

/** The Windows PCs the owner added: their names, permissions, last status and whether they were revoked. */
export class PcStore {
  constructor(
    private readonly db: Db,
    private readonly clock: () => number = Date.now,
  ) {}

  /** Adds a PC that has not signed in yet, and makes the one-time enrollment id the install command carries. */
  create(input: { name: string; permissions: PcPermissions }): { pc: Pc; enrollmentId: string } | { error: string } {
    const name = input.name.trim();
    if (!name || name.length > 60) return { error: "Give the PC a name of up to 60 characters." };
    if (this.byName(name)) return { error: `There is already a PC called ${name}.` };
    const perms = PcPermissions.safeParse(input.permissions);
    if (!perms.success) return { error: "Those permissions are not valid." };
    const now = this.clock();
    const id = Number(this.db.prepare("insert into pcs (name, perms_json, created_at) values (?, ?, ?)").run(name, JSON.stringify(perms.data), now).lastInsertRowid);
    const enrollmentId = randomBytes(18).toString("base64url");
    this.db.prepare("insert into pc_enroll (id, pc_id, created_at, expires_at) values (?, ?, ?, ?)").run(enrollmentId, id, now, now + ENROLLMENT_TTL_MS);
    return { pc: this.get(id)!, enrollmentId };
  }

  /** The PC an enrollment id belongs to, when it was not used and has not run out. */
  validEnrollment(enrollmentId: string): Pc | null {
    const r = this.db.prepare("select pc_id, expires_at, used from pc_enroll where id = ?").get(enrollmentId) as { pc_id: number; expires_at: number; used: number } | undefined;
    if (!r || r.used || r.expires_at < this.clock()) return null;
    const pc = this.get(r.pc_id);
    return pc && !pc.revoked ? pc : null;
  }

  /** A new one-time enrollment id for a PC that never signed in (the old ones stop working). */
  newEnrollment(pcId: number): string {
    const now = this.clock();
    this.db.prepare("delete from pc_enroll where pc_id = ? and used = 0 and approved = 0").run(pcId);
    const enrollmentId = randomBytes(18).toString("base64url");
    this.db.prepare("insert into pc_enroll (id, pc_id, created_at, expires_at) values (?, ?, ?, ?)").run(enrollmentId, pcId, now, now + ENROLLMENT_TTL_MS);
    return enrollmentId;
  }

  get(id: number): Pc | null {
    const r = this.db.prepare("select * from pcs where id = ?").get(id) as Row | undefined;
    return r ? this.pc(r) : null;
  }

  byName(name: string): Pc | null {
    const r = this.db.prepare("select * from pcs where name = ? collate nocase").get(name.trim()) as Row | undefined;
    return r ? this.pc(r) : null;
  }

  list(): Pc[] {
    return (this.db.prepare("select * from pcs order by name collate nocase").all() as Row[]).map((r) => this.pc(r));
  }

  setPermissions(id: number, permissions: PcPermissions): boolean {
    const p = PcPermissions.safeParse(permissions);
    return p.success && this.db.prepare("update pcs set perms_json = ? where id = ?").run(JSON.stringify(p.data), id).changes > 0;
  }

  rename(id: number, name: string): boolean {
    const clash = this.byName(name);
    if (!name.trim() || name.trim().length > 60 || (clash && clash.id !== id)) return false;
    return this.db.prepare("update pcs set name = ? where id = ?").run(name.trim(), id).changes > 0;
  }

  /** What the PC said about itself when it signed in or connected. */
  setIdentity(id: number, os: string, host: string): void {
    this.db.prepare("update pcs set os = ?, host = ? where id = ?").run(os.slice(0, 80), host.slice(0, 80), id);
  }

  setStatus(id: number, status: PcStatus): void {
    this.db.prepare("update pcs set status_json = ?, last_seen = ? where id = ?").run(JSON.stringify(status), this.clock(), id);
  }

  touch(id: number): void {
    this.db.prepare("update pcs set last_seen = ? where id = ?").run(this.clock(), id);
  }

  /** Ends everything the PC could use: its tokens are deleted and it can no longer sign in or refresh. */
  revoke(id: number): boolean {
    this.db.prepare("delete from pc_tokens where pc_id = ?").run(id);
    return this.db.prepare("update pcs set revoked = 1 where id = ?").run(id).changes > 0;
  }

  remove(id: number): boolean {
    return this.db.prepare("delete from pcs where id = ?").run(id).changes > 0;
  }

  private pc(r: Row): Pc {
    let permissions: PcPermissions = NO_PC_PERMISSIONS;
    let status: PcStatus | null = null;
    try {
      const p = PcPermissions.safeParse(JSON.parse(r.perms_json));
      if (p.success) permissions = p.data;
    } catch {
      /* a damaged row means everything off */
    }
    try {
      const s = PcStatus.safeParse(JSON.parse(r.status_json || "null"));
      if (s.success) status = s.data;
    } catch {
      /* no status yet */
    }
    return { id: r.id, name: r.name, os: r.os, host: r.host, permissions, status, createdAt: r.created_at, lastSeen: r.last_seen, revoked: r.revoked === 1 };
  }
}
