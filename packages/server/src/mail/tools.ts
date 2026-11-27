import { MAIL_TOOL_DEFS, wrapUntrusted, type MailClass } from "@friend/protocol";
import type { Audit } from "../audit";
import type { MailAutomationStore, MailWatch, RuleAction } from "./astore";
import { checkWatch } from "./automation";
import { renderTemplate, type RuleConditions } from "./logic";
import type { MailProvider } from "./provider";
import type { AskOwner, MailService, SendCause } from "./service";
import type { MailStore } from "./store";
import type { MailAccount, StoredMail } from "./types";

export interface MailToolResult {
  text: string;
  isError: boolean;
}

export interface PreparedMail {
  /** What the loop's own gate decides on. The mailbox's approval ladder does the asking, so this is T1 for every email tool. */
  tier: "T1";
  run(ask: AskOwner, signal: AbortSignal): Promise<MailToolResult>;
}

export interface MailToolsDeps {
  service: MailService;
  store: MailStore;
  auto: MailAutomationStore;
  provider: (accountId: number) => Promise<MailProvider>;
  audit: Audit;
  /** Whether the plugin is installed and switched on. */
  enabled: () => boolean;
  /** Tells the owner something that needs them (a case a role could not settle). */
  notify?: (text: string) => void;
  /** One look at a watch right now. */
  check?: (w: MailWatch) => Promise<{ ok: boolean; detail: string }>;
}

/** What a turn is about, when somebody else's mail started it: who wrote, which role, which case. */
export interface MailCtx {
  cause: SendCause;
  inboundFrom?: string;
  roleAuto?: boolean;
  caseId?: number;
}

/** How long after reading a stranger's mail every send asks, whatever the ladder says (the mail may have tried to steer it). */
const TAINT_MS = 10 * 60_000;

/** The only tools a turn may use when someone else's mail started it: read and answer that mail, and keep the case. Nothing else exists for it. */
export const MAIL_TURN_TOOLS: ReadonlySet<string> = new Set(["email.inbox", "email.read", "email.search", "email.reply", "email.send", "email.draft", "email.mark_read", "email.archive", "email.attachments", "email.case"]);

/** What the audit trail keeps of a call: where it went and how long it was, never the words. */
export function mailAuditArgs(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["account", "id", "to", "subject", "query", "limit", "before", "all", "action", "name", "status"]) if (a[k] !== undefined) out[k] = typeof a[k] === "string" ? String(a[k]).slice(0, 200) : a[k];
  for (const k of ["text", "note", "guidelines", "instruction"]) if (typeof a[k] === "string") out[`${k}Length`] = (a[k] as string).length;
  return out;
}

const ago = (t: number): string => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

const line = (m: StoredMail): string => `${m.id} | ${ago(m.date)} | ${m.class} | ${m.from.address} | ${m.subject.slice(0, 100) || "(no subject)"}${m.read ? "" : " | unread"}${m.attachments.length ? ` | ${m.attachments.length} attachment${m.attachments.length > 1 ? "s" : ""}` : ""}`;

/** Which tools need to know the mailbox: the rest (templates, roles, cases, schedules, watches) are about the owner's setup. */
function needsMailbox(name: string, a: Record<string, unknown>): boolean {
  if (name === "email.case" || name === "email.schedule" || name === "watch.manage") return false;
  if (name === "email.role") return a.action === "create";
  if (name === "email.template") return a.action === "send";
  return true;
}
/** Tools that set a standing order. Mail from someone else can never use them. */
const SETUP_TOOLS = new Set(["email.template", "email.rule", "email.role", "email.schedule", "watch.manage"]);

/** The assistant's email tools. Mail text is always shown marked as untrusted, and every send goes through the service's rules. */
export class MailTools {
  private taintedAt = 0;

  constructor(private readonly d: MailToolsDeps) {}

  prepare(name: string, rawArgs: Record<string, unknown>, ctx: MailCtx): { error: string } | PreparedMail {
    if (!this.d.enabled()) return { error: "Mailboxes are not switched on. The owner can switch them on under Plugins." };
    const def = MAIL_TOOL_DEFS.find((t) => t.name === name);
    if (!def) return { error: `Unknown tool: ${name}` };
    const parsed = def.input.safeParse(rawArgs);
    if (!parsed.success) return { error: `Invalid arguments for ${name}: ${parsed.error.message}` };
    const args = parsed.data as Record<string, unknown>;
    if (ctx.cause === "inbound-other" && SETUP_TOOLS.has(name) && args.action !== "list") return { error: "Mail from someone else cannot change what the assistant does. Only the owner can." };
    let account: MailAccount | null = null;
    if (needsMailbox(name, args)) {
      const picked = this.pick(typeof args.account === "string" ? args.account : undefined);
      if ("error" in picked) return picked;
      account = picked;
    }
    return { tier: "T1", run: (ask) => this.exec(name, args, account, ctx, ask).catch((e) => ({ text: e instanceof Error ? e.message : "The mail tool failed.", isError: true })) };
  }

  private pick(name?: string): MailAccount | { error: string } {
    const all = this.d.store.listAccounts().filter((a) => a.enabled);
    if (name) return all.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? { error: `There is no mailbox called ${name}. Mailboxes: ${all.map((a) => a.name).join(", ") || "none"}.` };
    if (all.length === 1) return all[0]!;
    return { error: all.length ? `Which mailbox? ${all.map((a) => a.name).join(", ")}.` : "There is no mailbox yet. The owner adds one under Plugins, Mailboxes." };
  }

  private async exec(name: string, a: Record<string, unknown>, box: MailAccount | null, ctx: MailCtx, ask: AskOwner): Promise<MailToolResult> {
    const { store } = this.d;
    const ok = (text: string): MailToolResult => ({ text, isError: false });
    const bad = (text: string): MailToolResult => ({ text, isError: true });
    if (SETUP_TOOLS.has(name) || name === "email.case") return this.setup(name, a, box, ctx, ask);
    const account = box!;
    const need = (id: unknown): StoredMail | null => store.getMessage(account.id, String(id));
    const missing = bad("I cannot find that mail. Use an id from email.inbox or email.search.");
    const roleTurn = ctx.cause === "inbound-other";
    const tainted = Date.now() - this.taintedAt < TAINT_MS;

    switch (name) {
      case "email.inbox": {
        const list = store.recentMessages(account.id, typeof a.limit === "number" ? a.limit : 20, typeof a.before === "number" ? a.before : undefined);
        const status = account.status === "online" ? "" : `Note: this mailbox is ${account.status}${account.statusDetail ? ` (${account.statusDetail})` : ""}.\n`;
        return ok(`${status}${list.length ? "id | when | from-class | from | subject\n" + list.map(line).join("\n") + `\n(older mail: before ${list.at(-1)!.id})` : "No mail."}`);
      }
      case "email.read": {
        const m = need(a.id);
        if (!m) return missing;
        if (m.class !== "owner") this.taintedAt = Date.now();
        return ok(wrapUntrusted(m, m.class as MailClass));
      }
      case "email.search": {
        const list = store.searchMessages(account.id, String(a.query), typeof a.limit === "number" ? a.limit : 20);
        return ok(list.length ? list.map(line).join("\n") : "Nothing found.");
      }
      case "email.attachments": {
        const m = need(a.id);
        if (!m) return missing;
        return ok(m.attachments.length ? m.attachments.map((x) => `${x.name} (${x.type}, ${x.size} bytes)`).join("\n") + "\nAttachments are never opened or run." : "No attachments.");
      }
      case "email.mark_read":
      case "email.archive": {
        const m = need(a.id);
        if (!m) return missing;
        const p = await this.d.provider(account.id);
        if (name === "email.mark_read") {
          await p.markRead(m.providerId);
          store.mark(account.id, m.id, { read: true });
          return ok("Marked as read.");
        }
        await p.archive(m.providerId);
        store.mark(account.id, m.id, { read: true, archived: true });
        return ok("Archived (moved out of the inbox; nothing was deleted).");
      }
      case "email.draft": {
        const id = store.saveDraft(account.id, { to: a.to as string[], subject: String(a.subject), text: String(a.text), ...(typeof a.inReplyTo === "string" ? { inReplyTo: a.inReplyTo } : {}) });
        return ok(`Draft ${id} saved for the owner to look at. It was not sent.`);
      }
      case "email.send":
      case "email.reply":
      case "email.forward": {
        const kind = name === "email.send" ? "send" : name === "email.reply" ? "reply" : "forward";
        let to = (a.to as string[] | undefined) ?? [];
        let subject = typeof a.subject === "string" ? a.subject : "";
        const text = typeof a.text === "string" ? a.text : typeof a.note === "string" ? a.note : "";
        let inReplyToId: string | undefined;
        if (kind !== "send") {
          const m = need(a.id);
          if (!m) return missing;
          inReplyToId = m.id;
          subject = m.subject;
          if (kind === "reply") {
            const own = account.address.toLowerCase();
            to = a.all && !roleTurn ? [...new Set([m.from.address, ...m.to.map((t) => t.address), ...m.cc.map((t) => t.address)].map((x) => x.toLowerCase()))].filter((x) => x !== own) : [m.from.address];
          }
        }
        const r = await this.d.service.send(account.id, { kind, to, subject, text, ...(inReplyToId ? { inReplyToId } : {}) }, { cause: ctx.cause, ...(ctx.inboundFrom ? { inboundFrom: ctx.inboundFrom } : {}), ...(ctx.roleAuto ? { roleAuto: true } : {}), ...(typeof a.why === "string" ? { why: a.why } : {}), tainted }, ask);
        return r.ok ? ok(`Sent${r.approver === "owner" ? " (the owner approved it)" : ""}.`) : bad(r.reason);
      }
      default:
        return bad(`Unknown tool: ${name}`);
    }
  }

  /** Templates, rules, roles, cases, schedules and watches. Anything that sets a standing order shows it to the owner and waits. */
  private async setup(name: string, a: Record<string, unknown>, box: MailAccount | null, ctx: MailCtx, ask: AskOwner): Promise<MailToolResult> {
    const { auto, service } = this.d;
    const ok = (text: string): MailToolResult => ({ text, isError: false });
    const bad = (text: string): MailToolResult => ({ text, isError: true });
    const action = String(a.action);
    const approve = async (reason: string, detail: string): Promise<boolean> => ask(reason, detail);
    const declined = bad("The owner declined, so nothing was changed.");
    const str = (k: string): string => (typeof a[k] === "string" ? (a[k] as string).trim() : "");

    if (name === "email.template") {
      if (action === "list") return ok(auto.listTemplates().map((t) => `${t.name}: "${t.subject}"`).join("\n") || "No templates yet.");
      if (action === "remove") return auto.removeTemplate(str("name")) ? ok("Template removed.") : bad("There is no such template.");
      if (action === "save") {
        if (!str("name") || !str("subject") || !str("text")) return bad("A template needs a name, a subject and a text.");
        auto.saveTemplate({ name: str("name"), subject: str("subject"), text: str("text") });
        return ok(`Template ${str("name")} saved. Values to fill in: ${[...new Set([...(str("subject") + str("text")).matchAll(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g)].map((m) => m[1]))].join(", ") || "none"}.`);
      }
      const tpl = auto.getTemplate(str("name"));
      if (!tpl) return bad("There is no such template.");
      const to = (a.to as string[] | undefined) ?? [];
      if (!to.length) return bad("Say who to send it to.");
      const filled = renderTemplate(tpl, (a.vars as Record<string, string> | undefined) ?? {});
      if (!filled.ok) return bad(`The template needs values for: ${filled.missing.join(", ")}.`);
      const r = await service.send(box!.id, { kind: "send", to, subject: filled.subject, text: filled.text }, { cause: ctx.cause, ...(ctx.inboundFrom ? { inboundFrom: ctx.inboundFrom } : {}), tainted: Date.now() - this.taintedAt < TAINT_MS }, ask);
      return r.ok ? ok(`Sent${r.approver === "owner" ? " (the owner approved it)" : ""}.`) : bad(r.reason);
    }

    if (name === "email.rule") {
      const account = box!;
      if (action === "list") return ok(auto.listRules(account.id).map((r) => `${r.name}: ${JSON.stringify(r.conditions)} -> ${r.action}${r.roleId ? ` (${auto.getRole(r.roleId)?.name ?? "role"})` : ""}`).join("\n") || "No rules.");
      if (action === "remove") {
        if (!(await approve(`Remove the mail rule "${str("name")}"`, `Mailbox ${account.name}`))) return declined;
        return auto.removeRule(account.id, str("name")) ? ok("Rule removed.") : bad("There is no such rule.");
      }
      const conditions: RuleConditions = {
        ...(Array.isArray(a.from) ? { from: a.from as string[] } : {}),
        ...(Array.isArray(a.to) ? { to: a.to as string[] } : {}),
        ...(str("subjectContains") ? { subjectContains: str("subjectContains") } : {}),
        ...(str("subjectRegex") ? { subjectRegex: str("subjectRegex") } : {}),
        ...(str("bodyContains") ? { bodyContains: str("bodyContains") } : {}),
        ...(typeof a.hasAttachment === "boolean" ? { hasAttachment: a.hasAttachment } : {}),
        ...(str("attachmentType") ? { attachmentType: str("attachmentType") } : {}),
      };
      if (!str("name") || !Object.keys(conditions).length) return bad("A rule needs a name and at least one condition.");
      const then = (str("then") || "notify") as RuleAction;
      const role = then === "role" ? auto.getRole(str("role")) : null;
      if (then === "role" && !role) return bad(`There is no role called ${str("role")}.`);
      if (!(await approve(`New mail rule "${str("name")}" for ${account.name}`, `When: ${JSON.stringify(conditions)}\nThen: ${then}${role ? ` (role ${role.name})` : ""}`))) return declined;
      auto.addRule(account.id, { name: str("name"), conditions, action: then, ...(role ? { roleId: role.id } : {}) });
      return ok("Rule added. The first rule that matches a mail decides what happens to it.");
    }

    if (name === "email.role") {
      if (action === "list") return ok(auto.listRoles().map((r) => `${r.name} (mailbox ${this.d.store.getAccount(r.accountId)?.name ?? "?"}, ${r.enabled ? "on" : "off"}, ${r.autoAnswer ? "answers by itself" : "asks before answering"}): ${r.guidelines.slice(0, 120)}`).join("\n") || "No roles.");
      if (action === "create") {
        const account = box!;
        if (!str("name") || str("guidelines").length < 10) return bad("A role needs a name and written guidelines.");
        if (auto.getRole(str("name"))) return bad(`There is already a role called ${str("name")}.`);
        const answers = a.autoAnswer === true;
        if (!(await approve(`New role "${str("name")}" on ${account.name}`, `It ${answers ? "ANSWERS THE PERSON WHO WROTE BY ITSELF (replies only, to that person only)" : "asks you before every answer"}.\n\nGuidelines:\n${str("guidelines")}`))) return declined;
        auto.createRole({ accountId: account.id, name: str("name"), guidelines: str("guidelines"), autoAnswer: answers });
        return ok("Role created. Add a rule with then: role to give it mail.");
      }
      const role = auto.getRole(str("name"));
      if (!role) return bad("There is no such role.");
      if (action === "remove") {
        if (!(await approve(`Remove the role "${role.name}"`, "The rules that gave it mail are removed with it."))) return declined;
        auto.removeRole(role.id);
        return ok("Role removed.");
      }
      if (!(await approve(`Change the role "${role.name}"`, `${typeof a.autoAnswer === "boolean" ? `Answers by itself: ${a.autoAnswer ? "YES" : "no"}\n` : ""}${typeof a.enabled === "boolean" ? `Switched ${a.enabled ? "on" : "off"}\n` : ""}${str("guidelines") ? `New guidelines:\n${str("guidelines")}` : ""}`))) return declined;
      auto.updateRole(role.id, { ...(str("guidelines") ? { guidelines: str("guidelines") } : {}), ...(typeof a.autoAnswer === "boolean" ? { autoAnswer: a.autoAnswer } : {}), ...(typeof a.enabled === "boolean" ? { enabled: a.enabled } : {}) });
      return ok("Role changed.");
    }

    if (name === "email.case") {
      const fmt = (c: ReturnType<typeof auto.listCases>[number]) => `${c.id} | ${c.status} | ${c.from} | ${c.subject}${c.note ? ` | ${c.note}` : ""}`;
      if (action === "list") return ok(auto.listCases(a.status ? { status: a.status as never } : {}).map(fmt).join("\n") || "No cases.");
      const id = typeof a.id === "number" ? a.id : ctx.caseId;
      if (id === undefined || !auto.getCase(id)) return bad("There is no such case.");
      if (ctx.cause === "inbound-other" && id !== ctx.caseId) return bad("You can only update the case you are working on.");
      auto.updateCase(id, { ...(a.status ? { status: a.status as never } : {}), ...(typeof a.note === "string" ? { note: a.note } : {}) });
      if (a.status === "escalated") {
        const c = auto.getCase(id)!;
        this.d.notify?.(`A mail needs you: "${c.subject}" from ${c.from}.${c.note ? ` ${c.note}` : ""}`);
      }
      return ok("Case updated.");
    }

    if (name === "email.schedule") {
      if (action === "list") return ok(auto.listSchedules().map((s) => `${s.name}: ${s.kind === "daily" ? `every day at ${s.at}` : `every ${s.minutes} minutes`}: ${s.instruction.slice(0, 120)}`).join("\n") || "No schedules.");
      if (action === "remove") {
        if (!(await approve(`Remove the schedule "${str("name")}"`, ""))) return declined;
        return auto.removeSchedule(str("name")) ? ok("Schedule removed.") : bad("There is no such schedule.");
      }
      if (!str("name") || !str("instruction")) return bad("A schedule needs a name and an instruction.");
      if (!a.daily && !a.everyMinutes) return bad("Say when: daily (HH:MM) or everyMinutes.");
      const kind = a.daily ? "daily" : "every";
      if (kind === "daily" && !/^([01]?\d|2[0-3]):[0-5]\d$/.test(String(a.daily))) return bad("The time must look like 08:00.");
      if (!(await approve(`New schedule "${str("name")}"`, `${kind === "daily" ? `Every day at ${a.daily}` : `Every ${a.everyMinutes} minutes`}, the assistant will:\n${str("instruction")}`))) return declined;
      auto.addSchedule({ name: str("name"), kind, ...(kind === "daily" ? { at: String(a.daily) } : { minutes: Number(a.everyMinutes) }), instruction: str("instruction") });
      return ok("Schedule added.");
    }

    // watch.manage
    const fmtW = (w: MailWatch) => `${w.name}: ${w.state}${w.detail ? ` (${w.detail})` : ""} | ${w.kind} ${w.target} every ${w.intervalSec}s`;
    if (action === "list") return ok(auto.listWatches().map(fmtW).join("\n") || "No watches.");
    if (action === "remove") {
      if (!(await approve(`Remove the watch "${str("name")}"`, ""))) return declined;
      return auto.removeWatch(str("name")) ? ok("Watch removed.") : bad("There is no such watch.");
    }
    if (action === "check") {
      const w = auto.listWatches().find((x) => x.name.toLowerCase() === str("name").toLowerCase());
      if (!w) return bad("There is no such watch.");
      const r = await (this.d.check ?? checkWatch)(w);
      return ok(`${w.name}: ${r.ok ? "OK" : "FAILING"}: ${r.detail}`);
    }
    const kind = (str("kind") || "http") as "http" | "tcp";
    const target = str("target");
    if (!str("name") || !target || !str("instruction")) return bad("A watch needs a name, a target and an instruction.");
    if (kind === "http" && !/^https?:\/\/[^\s]+$/i.test(target)) return bad("An http watch needs an address starting with http:// or https://.");
    if (kind === "tcp" && !/^[A-Za-z0-9.-]+:\d{1,5}$/.test(target)) return bad("A tcp watch needs host:port.");
    const every = typeof a.everySeconds === "number" ? a.everySeconds : 300;
    if (!(await approve(`New watch "${str("name")}"`, `Check ${kind} ${target} every ${every} seconds.\nIf it changes, the assistant will:\n${str("instruction")}`))) return declined;
    auto.addWatch({ name: str("name"), kind, target, intervalSec: every, ...(str("expectText") ? { expectText: str("expectText") } : {}), instruction: str("instruction") });
    return ok("Watch added. It wakes the assistant only when the state changes.");
  }
}
