import type { Db } from "../db";
import type { RuleConditions } from "./logic";
import type { WatchState } from "./watchstate";

export interface MailTemplate {
  id: number;
  name: string;
  subject: string;
  text: string;
}

export interface MailRole {
  id: number;
  accountId: number;
  name: string;
  guidelines: string;
  /** May answer the person who wrote by itself (replies only, to that person only). Off until the owner allows it. */
  autoAnswer: boolean;
  enabled: boolean;
}

export type RuleAction = "ignore" | "notify" | "role";
export interface MailRule {
  id: number;
  accountId: number;
  name: string;
  conditions: RuleConditions;
  action: RuleAction;
  roleId: number | null;
  enabled: boolean;
}

export type CaseStatus = "open" | "waiting" | "done" | "escalated";
export interface MailCase {
  id: number;
  accountId: number;
  roleId: number | null;
  threadId: string;
  subject: string;
  from: string;
  status: CaseStatus;
  note: string;
  lastMailId: string;
  createdAt: number;
  updatedAt: number;
}

export interface MailSchedule {
  id: number;
  name: string;
  kind: "daily" | "every";
  at: string;
  minutes: number;
  instruction: string;
  enabled: boolean;
  lastRun: number;
}

export interface MailWatch {
  id: number;
  name: string;
  kind: "http" | "tcp";
  target: string;
  intervalSec: number;
  expectText: string;
  instruction: string;
  state: WatchState;
  fails: number;
  lastCheck: number;
  lastChange: number;
  detail: string;
  enabled: boolean;
}

type Row = Record<string, string | number | null>;
const parse = <T>(s: unknown, fallback: T): T => {
  try {
    return s ? (JSON.parse(String(s)) as T) : fallback;
  } catch {
    return fallback;
  }
};

const role = (r: Row): MailRole => ({ id: r.id as number, accountId: r.account_id as number, name: r.name as string, guidelines: r.guidelines as string, autoAnswer: !!r.auto_answer, enabled: !!r.enabled });
const rule = (r: Row): MailRule => ({ id: r.id as number, accountId: r.account_id as number, name: r.name as string, conditions: parse<RuleConditions>(r.conditions_json, {}), action: r.action as RuleAction, roleId: (r.role_id as number | null) ?? null, enabled: !!r.enabled });
const kase = (r: Row): MailCase => ({ id: r.id as number, accountId: r.account_id as number, roleId: (r.role_id as number | null) ?? null, threadId: r.thread_id as string, subject: r.subject as string, from: r.from_addr as string, status: r.status as CaseStatus, note: r.note as string, lastMailId: r.last_mail_id as string, createdAt: r.created_at as number, updatedAt: r.updated_at as number });
const sched = (r: Row): MailSchedule => ({ id: r.id as number, name: r.name as string, kind: r.kind as "daily" | "every", at: r.at as string, minutes: r.minutes as number, instruction: r.instruction as string, enabled: !!r.enabled, lastRun: r.last_run as number });
const watch = (r: Row): MailWatch => ({ id: r.id as number, name: r.name as string, kind: r.kind as "http" | "tcp", target: r.target as string, intervalSec: r.interval_sec as number, expectText: r.expect_text as string, instruction: r.instruction as string, state: r.state as WatchState, fails: r.fails as number, lastCheck: r.last_check as number, lastChange: r.last_change as number, detail: r.detail as string, enabled: !!r.enabled });

/** Templates, rules, roles, cases, schedules and watches: what the assistant is told to do with mail and with time. */
export class MailAutomationStore {
  constructor(
    private readonly db: Db,
    private readonly clock: () => number = Date.now,
  ) {}

  // ---- templates ----
  saveTemplate(t: { name: string; subject: string; text: string }): MailTemplate {
    const had = this.db.prepare("select id from mail_templates where name = ? collate nocase").get(t.name.trim()) as { id: number } | undefined;
    if (had) this.db.prepare("update mail_templates set subject = ?, body = ? where id = ?").run(t.subject, t.text, had.id);
    else this.db.prepare("insert into mail_templates (name, subject, body, created_at) values (?,?,?,?)").run(t.name.trim(), t.subject, t.text, this.clock());
    return this.getTemplate(t.name)!;
  }
  getTemplate(name: string): MailTemplate | null {
    const r = this.db.prepare("select * from mail_templates where name = ? collate nocase").get(name.trim()) as Row | undefined;
    return r ? { id: r.id as number, name: r.name as string, subject: r.subject as string, text: r.body as string } : null;
  }
  listTemplates(): MailTemplate[] {
    return (this.db.prepare("select * from mail_templates order by name").all() as Row[]).map((r) => ({ id: r.id as number, name: r.name as string, subject: r.subject as string, text: r.body as string }));
  }
  removeTemplate(name: string): boolean {
    return this.db.prepare("delete from mail_templates where name = ? collate nocase").run(name.trim()).changes > 0;
  }

  // ---- roles ----
  createRole(r: { accountId: number; name: string; guidelines: string; autoAnswer?: boolean }): MailRole {
    if (this.getRole(r.name)) throw new Error(`There is already a role called ${r.name}.`);
    const id = Number(this.db.prepare("insert into mail_roles (account_id, name, guidelines, auto_answer, created_at) values (?,?,?,?,?)").run(r.accountId, r.name.trim(), r.guidelines, r.autoAnswer ? 1 : 0, this.clock()).lastInsertRowid);
    return this.getRole(id)!;
  }
  getRole(idOrName: number | string): MailRole | null {
    const r = (typeof idOrName === "number" ? this.db.prepare("select * from mail_roles where id = ?").get(idOrName) : this.db.prepare("select * from mail_roles where name = ? collate nocase").get(idOrName.trim())) as Row | undefined;
    return r ? role(r) : null;
  }
  listRoles(): MailRole[] {
    return (this.db.prepare("select * from mail_roles order by id").all() as Row[]).map(role);
  }
  updateRole(id: number, p: { guidelines?: string; autoAnswer?: boolean; enabled?: boolean }): void {
    if (p.guidelines !== undefined) this.db.prepare("update mail_roles set guidelines = ? where id = ?").run(p.guidelines, id);
    if (p.autoAnswer !== undefined) this.db.prepare("update mail_roles set auto_answer = ? where id = ?").run(p.autoAnswer ? 1 : 0, id);
    if (p.enabled !== undefined) this.db.prepare("update mail_roles set enabled = ? where id = ?").run(p.enabled ? 1 : 0, id);
  }
  removeRole(id: number): boolean {
    return this.db.prepare("delete from mail_roles where id = ?").run(id).changes > 0;
  }

  // ---- rules ----
  addRule(accountId: number, r: { name: string; conditions: RuleConditions; action: RuleAction; roleId?: number }): number {
    return Number(this.db.prepare("insert into mail_rules (account_id, name, conditions_json, action, role_id, created_at) values (?,?,?,?,?,?)").run(accountId, r.name.trim(), JSON.stringify(r.conditions), r.action, r.roleId ?? null, this.clock()).lastInsertRowid);
  }
  listRules(accountId: number): MailRule[] {
    return (this.db.prepare("select * from mail_rules where account_id = ? order by id").all(accountId) as Row[]).map(rule);
  }
  removeRule(accountId: number, idOrName: number | string): boolean {
    const q = typeof idOrName === "number" ? this.db.prepare("delete from mail_rules where account_id = ? and id = ?").run(accountId, idOrName) : this.db.prepare("delete from mail_rules where account_id = ? and name = ? collate nocase").run(accountId, idOrName.trim());
    return q.changes > 0;
  }

  // ---- cases ----
  /** The case for a conversation: opened, or opened again when more mail arrives in it. Its note is kept. */
  openCase(c: { accountId: number; roleId: number | null; threadId: string; subject: string; from: string; mailId: string }): MailCase {
    const now = this.clock();
    const had = this.db.prepare("select id from mail_cases where account_id = ? and thread_id = ?").get(c.accountId, c.threadId) as { id: number } | undefined;
    if (had) this.db.prepare("update mail_cases set status = 'open', last_mail_id = ?, updated_at = ?, role_id = coalesce(?, role_id) where id = ?").run(c.mailId, now, c.roleId, had.id);
    else this.db.prepare("insert into mail_cases (account_id, role_id, thread_id, subject, from_addr, last_mail_id, created_at, updated_at) values (?,?,?,?,?,?,?,?)").run(c.accountId, c.roleId, c.threadId, c.subject.slice(0, 300), c.from, c.mailId, now, now);
    return kase(this.db.prepare("select * from mail_cases where account_id = ? and thread_id = ?").get(c.accountId, c.threadId) as Row);
  }
  getCase(id: number): MailCase | null {
    const r = this.db.prepare("select * from mail_cases where id = ?").get(id) as Row | undefined;
    return r ? kase(r) : null;
  }
  updateCase(id: number, p: { status?: CaseStatus; note?: string }): void {
    if (p.status) this.db.prepare("update mail_cases set status = ?, updated_at = ? where id = ?").run(p.status, this.clock(), id);
    if (p.note !== undefined) this.db.prepare("update mail_cases set note = ?, updated_at = ? where id = ?").run(p.note.slice(0, 1000), this.clock(), id);
  }
  listCases(f: { status?: CaseStatus; limit?: number } = {}): MailCase[] {
    const rows = (f.status ? this.db.prepare("select * from mail_cases where status = ? order by updated_at desc limit ?").all(f.status, f.limit ?? 50) : this.db.prepare("select * from mail_cases order by updated_at desc limit ?").all(f.limit ?? 50)) as Row[];
    return rows.map(kase);
  }

  // ---- schedules ----
  addSchedule(s: { name: string; kind: "daily" | "every"; at?: string; minutes?: number; instruction: string }): MailSchedule {
    if (this.listSchedules().some((x) => x.name.toLowerCase() === s.name.trim().toLowerCase())) throw new Error(`There is already a schedule called ${s.name}.`);
    const now = this.clock();
    const id = Number(this.db.prepare("insert into mail_schedules (name, kind, at, minutes, instruction, last_run, created_at) values (?,?,?,?,?,?,?)").run(s.name.trim(), s.kind, s.at ?? "", s.minutes ?? 0, s.instruction, now, now).lastInsertRowid);
    return sched(this.db.prepare("select * from mail_schedules where id = ?").get(id) as Row);
  }
  listSchedules(): MailSchedule[] {
    return (this.db.prepare("select * from mail_schedules order by id").all() as Row[]).map(sched);
  }
  markScheduleRun(id: number): void {
    this.db.prepare("update mail_schedules set last_run = ? where id = ?").run(this.clock(), id);
  }
  removeSchedule(name: string): boolean {
    return this.db.prepare("delete from mail_schedules where name = ? collate nocase").run(name.trim()).changes > 0;
  }

  // ---- watches ----
  addWatch(w: { name: string; kind: "http" | "tcp"; target: string; intervalSec: number; expectText?: string; instruction: string }): MailWatch {
    if (this.listWatches().some((x) => x.name.toLowerCase() === w.name.trim().toLowerCase())) throw new Error(`There is already a watch called ${w.name}.`);
    const id = Number(this.db.prepare("insert into mail_watches (name, kind, target, interval_sec, expect_text, instruction, created_at) values (?,?,?,?,?,?,?)").run(w.name.trim(), w.kind, w.target, w.intervalSec, w.expectText ?? "", w.instruction, this.clock()).lastInsertRowid);
    return watch(this.db.prepare("select * from mail_watches where id = ?").get(id) as Row);
  }
  listWatches(): MailWatch[] {
    return (this.db.prepare("select * from mail_watches order by id").all() as Row[]).map(watch);
  }
  recordCheck(id: number, r: { state: WatchState; fails: number; detail: string; changed: boolean }): void {
    const now = this.clock();
    this.db.prepare("update mail_watches set state = ?, fails = ?, detail = ?, last_check = ?, last_change = case when ? then ? else last_change end where id = ?").run(r.state, r.fails, r.detail.slice(0, 300), now, r.changed ? 1 : 0, now, id);
  }
  removeWatch(name: string): boolean {
    return this.db.prepare("delete from mail_watches where name = ? collate nocase").run(name.trim()).changes > 0;
  }
}
