import { NO_PC_PERMISSIONS, PcPermissions, type PcStatus } from "@friend/protocol";
import type { Audit } from "../audit";
import type { Auth } from "../auth";
import type { Db } from "../db";
import { HttpError } from "../http-error";
import { PcEnroll, type Polled, type Refreshed, type Started } from "./enroll";
import { PcStore, type Pc } from "./store";

export interface PcView {
  id: number;
  name: string;
  os: string;
  host: string;
  online: boolean;
  permissions: PcPermissions;
  status: PcStatus | null;
  lastSeen: number;
  revoked: boolean;
  /** A control session, when one is running or paused. */
  lease: { until: number | null; paused: boolean } | null;
}

export interface PcServiceDeps {
  db: Db;
  auth: Pick<Auth, "verifyPin">;
  audit: Audit;
  clock?: () => number;
  /** Whether a PC has its socket open right now. */
  online?: (pcId: number) => boolean;
  /** A PC was revoked or removed: close its socket and end what it was doing. */
  onRevoke?: (pcId: number) => void;
  /** The control session of a PC, if there is one. */
  leaseInfo?: (pcId: number) => { until: number | null; paused: boolean } | null;
  /** Starts or ends a control session on a connected PC. */
  lease?: { start(pcId: number, minutes?: number): { ok: true } | { ok: false; error: string }; end(pcId: number): void };
  /** The owner changed what a PC may do: tell the PC if it is connected. */
  onPermissions?: (pcId: number, permissions: PcPermissions) => void;
}

/** Everything the owner and the PCs do with the list of PCs, with the PIN and the audit trail in one place. */
export class PcService {
  readonly store: PcStore;
  readonly enroll: PcEnroll;
  constructor(private readonly deps: PcServiceDeps) {
    this.store = new PcStore(deps.db, deps.clock);
    this.enroll = new PcEnroll(deps.db, this.store, deps.clock);
  }

  view(pc: Pc): PcView {
    const online = this.deps.online?.(pc.id) ?? false;
    return { id: pc.id, name: pc.name, os: pc.os, host: pc.host, online, permissions: pc.permissions, status: online ? pc.status : pc.status ? { ...pc.status, state: "offline" } : null, lastSeen: pc.lastSeen, revoked: pc.revoked, lease: online ? this.deps.leaseInfo?.(pc.id) ?? null : null };
  }

  list(): PcView[] {
    return this.store.list().map((p) => this.view(p));
  }

  private async pin(pin: string, ip: string): Promise<void> {
    if (!(await this.deps.auth.verifyPin(pin, ip))) throw new HttpError(403, "Incorrect PIN");
  }

  /** The owner adds a PC. It starts with everything off unless the owner chose; the PC itself signs in later with the enrollment id. */
  async add(input: { name: string; permissions?: PcPermissions | undefined }, pin: string, ip: string): Promise<{ pc: PcView; enrollmentId: string }> {
    await this.pin(pin, ip);
    const made = this.store.create({ name: input.name, permissions: input.permissions ?? NO_PC_PERMISSIONS });
    if ("error" in made) throw new HttpError(400, made.error);
    this.deps.audit.log("owner", "pc.added", { pc: made.pc.name, ip });
    return { pc: this.view(made.pc), enrollmentId: made.enrollmentId };
  }

  /** A new enrollment id for a PC that has not signed in yet (the install command was lost). */
  async reissue(id: number, pin: string, ip: string): Promise<{ enrollmentId: string }> {
    await this.pin(pin, ip);
    const pc = this.store.get(id);
    if (!pc) throw new HttpError(404, "There is no such PC.");
    // a revoked PC is added again with the same name and permissions: it signs in afresh with the new command
    if (pc.revoked) this.store.restore(id);
    const enrollmentId = this.store.newEnrollment(id);
    this.deps.audit.log("owner", pc.revoked ? "pc.readded" : "pc.reissued", { pc: pc.name, ip });
    return { enrollmentId };
  }

  start(input: { enrollmentId: string; challenge: string; os: string; host: string }, ip: string): Started | { error: string } {
    const r = this.enroll.start(input);
    this.deps.audit.log("anonymous", "pc.enroll.start", { ip, ok: !("error" in r), host: input.host.slice(0, 60) });
    return r;
  }

  token(input: { deviceCode: string; verifier: string }): Polled {
    return this.enroll.poll(input);
  }

  refresh(refresh: string, ip: string): Refreshed {
    const r = this.enroll.refresh(refresh);
    if ("error" in r) this.deps.audit.log("anonymous", "pc.refresh.refused", { ip });
    return r;
  }

  lookup(code: string): ReturnType<PcEnroll["lookup"]> {
    return this.enroll.lookup(code);
  }

  async approve(code: string, choices: { permissions?: PcPermissions | undefined; name?: string | undefined }, pin: string, ip: string): Promise<{ pc: PcView }> {
    await this.pin(pin, ip);
    let id: number;
    try {
      id = this.enroll.approve(code, { ...(choices.permissions ? { permissions: choices.permissions } : {}), ...(choices.name ? { name: choices.name } : {}) });
    } catch (e) {
      throw new HttpError(400, (e as Error).message);
    }
    const pc = this.store.get(id)!;
    this.deps.audit.log("owner", "pc.approved", { pc: pc.name, host: pc.host, ip });
    return { pc: this.view(pc) };
  }

  async setPermissions(id: number, permissions: PcPermissions, pin: string, ip: string): Promise<PcView> {
    await this.pin(pin, ip);
    const before = this.store.get(id);
    if (!before || !this.store.setPermissions(id, permissions)) throw new HttpError(404, "There is no such PC, or those permissions are not valid.");
    this.deps.audit.log("owner", "pc.permissions", { pc: before.name, from: before.permissions, to: permissions, ip });
    this.deps.onPermissions?.(id, permissions);
    return this.view(this.store.get(id)!);
  }

  /** The owner starts or ends a control session from the screen. */
  control(id: number, action: "start" | "stop", minutes: number | undefined, ip: string): void {
    const pc = this.store.get(id);
    if (!pc || pc.revoked) throw new HttpError(404, "There is no such PC.");
    if (action === "start") {
      if (!pc.permissions.control) throw new HttpError(400, "This PC is not allowed to be controlled. Switch on Control in its permissions first.");
      const r = this.deps.lease?.start(id, minutes);
      if (!r || !r.ok) throw new HttpError(409, r && !r.ok ? r.error : "The PC is not connected.");
    } else this.deps.lease?.end(id);
    this.deps.audit.log("owner", action === "start" ? "pc.control.start" : "pc.control.stop", { pc: pc.name, minutes: minutes ?? null, by: "owner", ip });
  }

  async revoke(id: number, pin: string, ip: string): Promise<void> {
    await this.pin(pin, ip);
    const pc = this.store.get(id);
    if (!pc) throw new HttpError(404, "There is no such PC.");
    this.store.revoke(id);
    this.deps.onRevoke?.(id);
    this.deps.audit.log("owner", "pc.revoked", { pc: pc.name, ip });
  }

  async remove(id: number, pin: string, ip: string): Promise<void> {
    await this.pin(pin, ip);
    const pc = this.store.get(id);
    if (!pc) throw new HttpError(404, "There is no such PC.");
    this.store.revoke(id);
    this.deps.onRevoke?.(id);
    this.store.remove(id);
    this.deps.audit.log("owner", "pc.removed", { pc: pc.name, ip });
  }
}
