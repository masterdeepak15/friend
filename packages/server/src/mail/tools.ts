import { MAIL_TOOL_DEFS, wrapUntrusted, type MailClass } from "@friend/protocol";
import type { Audit } from "../audit";
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
  provider: (accountId: number) => Promise<MailProvider>;
  audit: Audit;
  /** Whether the plugin is installed and switched on. */
  enabled: () => boolean;
}

/** How long after reading a stranger's mail every send asks, whatever the ladder says (the mail may have tried to steer it). */
const TAINT_MS = 10 * 60_000;

const ago = (t: number): string => {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 90 ? "just now" : s < 5400 ? `${Math.round(s / 60)} min ago` : s < 129600 ? `${Math.round(s / 3600)} h ago` : `${Math.round(s / 86400)} days ago`;
};

const line = (m: StoredMail): string => `${m.id} | ${ago(m.date)} | ${m.class} | ${m.from.address} | ${m.subject.slice(0, 100) || "(no subject)"}${m.read ? "" : " | unread"}${m.attachments.length ? ` | ${m.attachments.length} attachment${m.attachments.length > 1 ? "s" : ""}` : ""}`;

/** What the audit trail keeps of a call: where it went and how long it was, never the words. */
export function mailAuditArgs(a: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of ["account", "id", "to", "subject", "query", "limit", "before", "all"]) if (a[k] !== undefined) out[k] = typeof a[k] === "string" ? String(a[k]).slice(0, 200) : a[k];
  for (const k of ["text", "note"]) if (typeof a[k] === "string") out[`${k}Length`] = (a[k] as string).length;
  return out;
}

/** The assistant's email tools. Mail text is always shown marked as untrusted, and every send goes through the service's rules. */
export class MailTools {
  private taintedAt = 0;

  constructor(private readonly d: MailToolsDeps) {}

  prepare(name: string, rawArgs: Record<string, unknown>, ctx: { cause: SendCause }): { error: string } | PreparedMail {
    if (!this.d.enabled()) return { error: "Mailboxes are not switched on. The owner can switch them on under Plugins." };
    const def = MAIL_TOOL_DEFS.find((t) => t.name === name);
    if (!def) return { error: `Unknown tool: ${name}` };
    const parsed = def.input.safeParse(rawArgs);
    if (!parsed.success) return { error: `Invalid arguments for ${name}: ${parsed.error.message}` };
    const args = parsed.data as Record<string, unknown>;
    const account = this.pick(typeof args.account === "string" ? args.account : undefined);
    if ("error" in account) return account;
    return { tier: "T1", run: (ask) => this.exec(name, args, account, ctx.cause, ask).catch((e) => ({ text: e instanceof Error ? e.message : "The mail tool failed.", isError: true })) };
  }

  private pick(name?: string): MailAccount | { error: string } {
    const all = this.d.store.listAccounts().filter((a) => a.enabled);
    if (name) return all.find((a) => a.name.toLowerCase() === name.toLowerCase()) ?? { error: `There is no mailbox called ${name}. Mailboxes: ${all.map((a) => a.name).join(", ") || "none"}.` };
    if (all.length === 1) return all[0]!;
    return { error: all.length ? `Which mailbox? ${all.map((a) => a.name).join(", ")}.` : "There is no mailbox yet. The owner adds one under Plugins, Mailboxes." };
  }

  private async exec(name: string, a: Record<string, unknown>, account: MailAccount, cause: SendCause, ask: AskOwner): Promise<MailToolResult> {
    const { store } = this.d;
    const ok = (text: string): MailToolResult => ({ text, isError: false });
    const bad = (text: string): MailToolResult => ({ text, isError: true });
    const need = (id: unknown): StoredMail | null => store.getMessage(account.id, String(id));
    const missing = bad("I cannot find that mail. Use an id from email.inbox or email.search.");
    const tainted = Date.now() - this.taintedAt < TAINT_MS;

    switch (name) {
      case "email.inbox": {
        const list = store.recentMessages(account.id, typeof a.limit === "number" ? a.limit : 20, typeof a.before === "number" ? a.before : undefined);
        const status = account.status === "online" ? "" : `Note: this mailbox is ${account.status}${account.statusDetail ? ` (${account.statusDetail})` : ""}.\n`;
        return ok(`${status}${list.length ? "id | when | from-class | from | subject\n" + list.map(line).join("\n") + (list.length ? `\n(older mail: before ${list.at(-1)!.id})` : "") : "No mail."}`);
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
        let text = typeof a.text === "string" ? a.text : typeof a.note === "string" ? a.note : "";
        let inReplyToId: string | undefined;
        if (kind !== "send") {
          const m = need(a.id);
          if (!m) return missing;
          inReplyToId = m.id;
          subject = m.subject;
          if (kind === "reply") {
            const own = account.address.toLowerCase();
            to = a.all ? [...new Set([m.from.address, ...m.to.map((t) => t.address), ...m.cc.map((t) => t.address)].map((x) => x.toLowerCase()))].filter((x) => x !== own) : [m.from.address];
          }
        }
        const r = await this.d.service.send(account.id, { kind, to, subject, text, ...(inReplyToId ? { inReplyToId } : {}) }, { cause, tainted }, ask);
        return r.ok ? ok(`Sent${r.approver === "owner" ? " (the owner approved it)" : ""}.`) : bad(r.reason);
      }
      default:
        return bad(`Unknown tool: ${name}`);
    }
  }
}
