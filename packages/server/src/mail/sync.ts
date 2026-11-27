import { classifyMail, type MailClass, type MailMessage } from "@friend/protocol";
import type { Audit } from "../audit";
import { MailAuthError, type MailProvider } from "./provider";
import type { MailStore } from "./store";

const BATCH = 50;
const POLL_MS = 60_000;
/** Waits after the 1st, 2nd, 3rd and 4th failure to hand a mail on; the 5th failure puts it away as dead. */
const RETRY_MS = [60_000, 5 * 60_000, 30 * 60_000, 30 * 60_000];

export interface MailSyncDeps {
  store: MailStore;
  /** A connected-on-demand provider for a mailbox. */
  open: (accountId: number) => Promise<MailProvider>;
  /** Hands a new mail on (to the assistant). It was stored first; `msg.id` is its stored id. */
  onMail: (msg: MailMessage, cls: MailClass) => Promise<void>;
  audit: Audit;
}

/**
 * Brings each mailbox's new mail in, keeps it, and hands each arrival on exactly once: an arrival is claimed in the database before
 * it is handled, so a second sync, a restart or a lost cursor cannot run it twice. A failed hand-over is retried later, then put away.
 */
export class MailSync {
  private running = new Map<number, Promise<void>>();
  private providers = new Map<number, MailProvider>();
  private watchers = new Map<number, () => void>();
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly d: MailSyncDeps) {}

  start(): void {
    if (this.timer) return;
    const tick = () => {
      for (const a of this.d.store.listAccounts()) if (a.enabled) void this.syncNow(a.id).catch(() => {});
    };
    this.timer = setInterval(tick, POLL_MS);
    this.timer.unref();
    tick();
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const stop of this.watchers.values()) stop();
    this.watchers.clear();
    await Promise.all([...this.providers.keys()].map((id) => this.forget(id)));
  }

  /** Drops what is held for a mailbox (its settings or password changed, or it was removed). */
  async forget(accountId: number): Promise<void> {
    this.watchers.get(accountId)?.();
    this.watchers.delete(accountId);
    const p = this.providers.get(accountId);
    this.providers.delete(accountId);
    await p?.disconnect().catch(() => {});
  }

  syncNow(accountId: number): Promise<void> {
    const have = this.running.get(accountId);
    if (have) return have;
    const run = this.run(accountId).finally(() => this.running.delete(accountId));
    this.running.set(accountId, run);
    return run;
  }

  /** The provider for a mailbox, opened once and kept. */
  async use(accountId: number): Promise<MailProvider> {
    let p = this.providers.get(accountId);
    if (!p) {
      p = await this.d.open(accountId);
      this.providers.set(accountId, p);
      this.watchers.set(
        accountId,
        p.onNew(() => void this.syncNow(accountId).catch(() => {})),
      );
    }
    return p;
  }

  private async run(accountId: number): Promise<void> {
    const { store } = this.d;
    const account = store.getAccount(accountId);
    if (!account || !account.enabled || account.status === "needs-sign-in") return;
    try {
      const p = await this.use(accountId);
      await p.connect();
      for (;;) {
        const fresh = store.getAccount(accountId)!;
        const r = await p.fetchSince(fresh.cursor, BATCH);
        for (const raw of r.messages) {
          const msg = { ...raw, accountId };
          const cls = classifyMail(msg, fresh.owners, fresh.systems);
          store.saveMessage(msg, cls);
          if (!r.backfill) store.claimEvent(accountId, "email.received", msg.providerId);
        }
        store.updateAccount(accountId, { cursor: r.cursor });
        if (r.backfill || r.messages.length < BATCH) break;
      }
      store.updateAccount(accountId, { status: "online", statusDetail: "" });
    } catch (e) {
      const message = e instanceof Error ? e.message : "The mailbox could not be read.";
      if (e instanceof MailAuthError) {
        store.updateAccount(accountId, { status: "needs-sign-in", statusDetail: message });
        await this.forget(accountId);
      } else {
        store.updateAccount(accountId, { status: "error", statusDetail: message });
        await this.forget(accountId); // reconnect fresh next time
      }
      this.d.audit.log("system", "mail.sync.failed", { account: account.name, kind: e instanceof MailAuthError ? "auth" : "network" });
    }
    await this.deliver(accountId);
  }

  /** Hands on every claimed arrival that is due, one at a time. */
  private async deliver(accountId: number): Promise<void> {
    const { store } = this.d;
    for (const ev of store.pendingEvents(accountId)) {
      const stored = store.getMessageByProviderId(accountId, ev.providerId);
      if (!stored) {
        store.failEvent(ev.id, "The mail is not stored.", null);
        continue;
      }
      try {
        await this.d.onMail(stored, stored.class);
        store.finishEvent(ev.id);
      } catch (e) {
        const wait = RETRY_MS[ev.attempts] ?? null;
        store.failEvent(ev.id, e instanceof Error ? e.message : "failed", wait);
        if (wait === null) this.d.audit.log("system", "mail.event.dead", { account: accountId, kind: ev.kind });
      }
    }
  }
}
