import type { Audit } from "../audit";
import type { Auth } from "../auth";
import { HttpError } from "../http-error";
import type { ImapSmtpSettings } from "./imap";
import type { MailSecrets, MailStore } from "./store";
import type { Ladder, MailAccount } from "./types";

export interface MailAccountInput {
  name: string;
  address: string;
  imap: MailAccount["imap"];
  smtp: MailAccount["smtp"];
  username: string;
  owners: string[];
  systems: string[];
}

/** What the owner sees of a mailbox: everything but the password, which only says whether one is saved. */
export interface MailAccountView extends Omit<MailAccount, "cursor"> {
  hasPassword: boolean;
}

export interface MailAccountsDeps {
  store: MailStore;
  secrets: MailSecrets;
  auth: Pick<Auth, "verifyPin">;
  audit: Audit;
  /** Tries a login for real (or in a test, pretends). Throws with a plain sentence when it fails. */
  check: (settings: ImapSmtpSettings) => Promise<void>;
  /** A mailbox changed or was removed: whatever is held open for it is dropped. */
  changed: (id: number) => Promise<void>;
}

const clean = (list: string[]): string[] => [...new Set(list.map((a) => a.trim().toLowerCase()).filter(Boolean))];

/** Adding, changing and removing mailboxes. Everything here needs the PIN, and a login is tested before anything is saved. */
export class MailAccounts {
  constructor(private readonly d: MailAccountsDeps) {}

  private async pin(pin: string, ip: string): Promise<void> {
    if (!(await this.d.auth.verifyPin(pin, ip))) throw new HttpError(403, "Incorrect PIN");
  }

  private view(a: MailAccount): MailAccountView {
    const { cursor: _cursor, ...rest } = a;
    return { ...rest, hasPassword: this.d.secrets.get(a.id) !== null };
  }

  list(): MailAccountView[] {
    return this.d.store.listAccounts().map((a) => this.view(a));
  }

  private async tryLogin(input: MailAccountInput, password: string): Promise<void> {
    try {
      await this.d.check({ imap: input.imap, smtp: input.smtp, username: input.username, password });
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "The mailbox could not be reached.");
    }
  }

  async add(input: MailAccountInput, password: string, pin: string, ip: string): Promise<MailAccountView> {
    await this.pin(pin, ip);
    if (this.d.store.accountByName(input.name)) throw new HttpError(409, `There is already a mailbox called ${input.name}.`);
    await this.tryLogin(input, password);
    const a = this.d.store.createAccount({ ...input, owners: clean(input.owners), systems: clean(input.systems) });
    this.d.secrets.set(a.id, password);
    this.d.store.updateAccount(a.id, { status: "new" });
    this.d.audit.log("owner", "mail.account_added", { account: a.name, address: a.address });
    await this.d.changed(a.id);
    return this.view(this.d.store.getAccount(a.id)!);
  }

  async update(id: number, input: Partial<MailAccountInput> & { enabled?: boolean }, password: string | undefined, pin: string, ip: string): Promise<MailAccountView> {
    await this.pin(pin, ip);
    const cur = this.d.store.getAccount(id);
    if (!cur) throw new HttpError(404, "There is no such mailbox.");
    if (input.name && input.name.toLowerCase() !== cur.name.toLowerCase() && this.d.store.accountByName(input.name)) throw new HttpError(409, `There is already a mailbox called ${input.name}.`);
    const merged: MailAccountInput = { name: input.name ?? cur.name, address: input.address ?? cur.address, imap: input.imap ?? cur.imap, smtp: input.smtp ?? cur.smtp, username: input.username ?? cur.username, owners: input.owners ?? cur.owners, systems: input.systems ?? cur.systems };
    const loginChanged = password !== undefined || !!input.imap || !!input.smtp || input.username !== undefined;
    if (loginChanged) {
      const pw = password ?? this.d.secrets.get(id);
      if (!pw) throw new HttpError(400, "Enter the mailbox's password.");
      await this.tryLogin(merged, pw);
      if (password !== undefined) this.d.secrets.set(id, password);
    }
    this.d.store.updateAccount(id, { ...merged, owners: clean(merged.owners), systems: clean(merged.systems), ...(input.enabled !== undefined ? { enabled: input.enabled } : {}), ...(loginChanged ? { status: "new", statusDetail: "" } : {}) });
    this.d.audit.log("owner", "mail.account_changed", { account: merged.name, login: loginChanged });
    await this.d.changed(id);
    return this.view(this.d.store.getAccount(id)!);
  }

  async setLadder(id: number, ladder: Ladder, pin: string, ip: string): Promise<MailAccountView> {
    await this.pin(pin, ip);
    const cur = this.d.store.getAccount(id);
    if (!cur) throw new HttpError(404, "There is no such mailbox.");
    this.d.store.updateAccount(id, { ladder });
    this.d.audit.log("owner", "mail.ladder_changed", { account: cur.name, ladder });
    return this.view(this.d.store.getAccount(id)!);
  }

  async remove(id: number, pin: string, ip: string): Promise<void> {
    await this.pin(pin, ip);
    const cur = this.d.store.getAccount(id);
    if (!cur) throw new HttpError(404, "There is no such mailbox.");
    this.d.store.deleteAccount(id);
    this.d.secrets.clear(id);
    this.d.audit.log("owner", "mail.account_removed", { account: cur.name });
    await this.d.changed(id);
  }

  /** Tries the saved login again, and wakes the sync if it works. */
  async test(id: number): Promise<{ ok: boolean; error?: string }> {
    const a = this.d.store.getAccount(id);
    if (!a) throw new HttpError(404, "There is no such mailbox.");
    const pw = this.d.secrets.get(id);
    if (!pw) return { ok: false, error: "No password is saved." };
    try {
      await this.d.check({ imap: a.imap, smtp: a.smtp, username: a.username, password: pw });
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "The mailbox could not be reached." };
    }
    if (a.status === "needs-sign-in" || a.status === "error") this.d.store.updateAccount(id, { status: "new", statusDetail: "" });
    await this.d.changed(id);
    return { ok: true };
  }
}
