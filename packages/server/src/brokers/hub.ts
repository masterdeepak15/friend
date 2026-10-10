import type { Audit } from "../audit";
import type { ChannelHub } from "../channels/hub";
import type { Config } from "../config";
import type { Db } from "../db";
import { Portfolio, type PortfolioSnapshot } from "./portfolio";
import { buildReport, type ReportKind } from "./report";
import { localDay, localTime, localWeekday, ReportScheduler, type Schedule } from "./scheduler";
import { ReportSchedules } from "./schedules";
import { BrokerSessions } from "./session";
import { BrokerError, type BrokerProvider, type Capabilities } from "./types";
import { createZerodha } from "./zerodha";

export interface BrokerHubDeps {
  config: Config;
  dataDir: string;
  db: Db;
  audit: Audit;
  channels: Pick<ChannelHub, "send">;
  clock?: () => number;
  fetch?: typeof fetch;
  /** Friend's public address (no trailing slash), where the broker sends the owner back after login. Null when there is none. */
  publicBase: () => string | null;
}

export interface BrokerStatus {
  installed: boolean;
  enabled: boolean;
  keySet: boolean;
  secretSet: boolean;
  loggedIn: boolean;
  /** When the login ends (epoch milliseconds), or null. */
  expiresAt: number | null;
  detail: string;
}

export type ReportResult = { ok: true; text: string } | { ok: false; error: string; sessionExpired?: boolean };
export type SnapshotResult = { ok: true; snapshot: PortfolioSnapshot; caps: Capabilities; broker: string; zone: string } | { ok: false; error: string; sessionExpired?: boolean };
export type LoginResult = { ok: true } | { ok: false; error: string };

const NAMES: Record<string, string> = { zerodha: "Zerodha" };
const minutes = (hhmm: string): number => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

/**
 * Everything about the owner's stock brokers in one place: which are usable, the daily login, reading the account, building
 * and delivering reports, and the reminder to log in. A new broker is one more entry in `build`.
 */
export class BrokerHub {
  readonly schedules: ReportSchedules;
  private sessions: BrokerSessions;
  private scheduler: ReportScheduler;
  private providers = new Map<string, { provider: BrokerProvider; portfolio: Portfolio; made: string }>();
  /** The local day a login link was last sent, so the owner gets one link a day, not one per try. */
  private linkDay: string | null = null;

  constructor(private d: BrokerHubDeps) {
    this.schedules = new ReportSchedules(d.db);
    this.sessions = new BrokerSessions(d.dataDir, this.now);
    this.scheduler = new ReportScheduler({
      schedules: this.schedules,
      zone: () => d.config.brokers.timezone,
      skipDates: () => d.config.brokers.skipDates,
      run: (s) => this.deliver(s),
    });
  }

  private now = (): number => (this.d.clock ?? Date.now)();
  private today = (at = new Date(this.now())): string => localDay(at, this.d.config.brokers.timezone);
  private name = (id: string): string => NAMES[id] ?? id;

  /** Brings the brokers in line with the settings: builds what is usable, drops what is not, and picks up a saved login. */
  apply(): void {
    const z = this.d.config.brokers.zerodha;
    const usable = z.installed && z.enabled && !!z.apiKey && !!z.apiSecret;
    const made = `${z.apiKey}\n${z.apiSecret}`;
    const have = this.providers.get("zerodha");
    if (!usable) this.providers.delete("zerodha");
    else if (!have || have.made !== made) {
      const provider = createZerodha({ apiKey: z.apiKey, apiSecret: z.apiSecret!, fetch: this.d.fetch, clock: this.now });
      this.providers.set("zerodha", { provider, portfolio: new Portfolio(provider, this.now), made });
    }
    const now = this.providers.get("zerodha");
    if (now) {
      now.provider.setSession(this.sessions.load("zerodha"));
      now.portfolio.invalidate();
    }
  }

  /** Forgets everything kept for a broker (when it is removed). */
  forget(id: string): void {
    this.providers.delete(id);
    this.sessions.clear(id);
  }

  portfolio(id: string): Portfolio | null {
    return this.providers.get(id)?.portfolio ?? null;
  }

  capabilities(id: string): Capabilities | null {
    return this.providers.get(id)?.provider.capabilities ?? null;
  }

  status(id: string): BrokerStatus {
    const z = this.d.config.brokers.zerodha;
    const known = id === "zerodha";
    const entry = this.providers.get(id);
    const expiresAt = entry?.provider.sessionExpiresAt() ?? null;
    const loggedIn = expiresAt !== null && expiresAt > this.now();
    const base = { installed: known && z.installed, enabled: known && z.enabled, keySet: known && !!z.apiKey, secretSet: known && !!z.apiSecret };
    let detail = "Not set up.";
    if (known && z.installed && !entry) detail = z.enabled ? "Add the API key and secret to finish." : "Switched off.";
    else if (entry) detail = loggedIn ? "Logged in. The login ends at 6 am tomorrow." : "Login needed: open the login link and sign in at Zerodha.";
    return { ...base, loggedIn, expiresAt: loggedIn ? expiresAt : null, detail };
  }

  /** Where the owner must register Friend's return address at the broker. */
  redirectUrl(id: string): string | null {
    const base = this.d.publicBase();
    return base ? `${base.replace(/\/+$/, "")}/api/brokers/${id}/callback` : null;
  }

  /** The broker's login page with a one-time code, or null when that broker is not usable. */
  loginLink(id: string): string | null {
    const entry = this.providers.get(id);
    if (!entry || entry.provider.login.kind !== "redirect") return null;
    return entry.provider.login.loginUrl(this.sessions.newState(id));
  }

  /** Finishes a login from the broker's redirect. Only a code Friend issued, once, within ten minutes, is accepted. */
  async completeLogin(params: Record<string, string>): Promise<LoginResult> {
    const id = this.sessions.takeState(params.state ?? "");
    const entry = id ? this.providers.get(id) : undefined;
    if (!id || !entry) return { ok: false, error: "This login link is not valid any more. Ask Friend for a new one." };
    if (entry.provider.login.kind !== "redirect") return { ok: false, error: "This broker does not log in this way." };
    if (params.status && params.status !== "success") return { ok: false, error: "The broker did not complete the login." };
    try {
      const info = await entry.provider.login.complete(params);
      this.sessions.save(id, info);
      entry.provider.setSession(info);
      entry.portfolio.invalidate();
    } catch (e) {
      return { ok: false, error: e instanceof BrokerError ? e.message : "The login could not be completed." };
    }
    this.d.audit.log("owner", "broker.login", { broker: id });
    // reports that were waiting for this login go out now
    await this.schedules.resetAttempts();
    await this.scheduler.tick(new Date(this.now())).catch(() => 0);
    return { ok: true };
  }

  /** The account as it is now, or why it cannot be read (a login that has ended is cleaned up here, once, for every caller). */
  async snapshot(id: string): Promise<SnapshotResult> {
    const entry = this.providers.get(id);
    if (!entry) return { ok: false, error: `${this.name(id)} is not installed or not switched on.` };
    const ended: SnapshotResult = { ok: false, error: `Login needed: the ${this.name(id)} login has ended.`, sessionExpired: true };
    if (!entry.provider.sessionExpiresAt()) return ended;
    const snapshot = await entry.portfolio.snapshot();
    const sections = [snapshot.holdings, snapshot.positions, snapshot.funds, snapshot.orders];
    if (sections.some((s) => !s.ok && s.kind === "session")) {
      this.sessions.clear(id);
      entry.provider.setSession(null);
      entry.portfolio.invalidate();
      this.d.audit.log("system", "broker.session_ended", { broker: id });
      return ended;
    }
    return { ok: true, snapshot, caps: entry.provider.capabilities, broker: this.name(id), zone: this.d.config.brokers.timezone };
  }

  /** Builds the report text from the live account. Never sends it. */
  async report(id: string, kind: ReportKind = "custom"): Promise<ReportResult> {
    const got = await this.snapshot(id);
    if (!got.ok) return got;
    const text = buildReport({ snapshot: got.snapshot, kind, caps: got.caps, now: new Date(this.now()), broker: got.broker, zone: got.zone });
    this.d.audit.log("system", "broker.report", { broker: id, kind, lines: text.split("\n").length });
    return { ok: true, text };
  }

  /** Sends one scheduled report. Throws when it could not go out, so the scheduler tries again. */
  async deliver(s: Schedule): Promise<void> {
    const r = await this.report(s.broker, s.kind);
    if (!r.ok && r.sessionExpired) {
      await this.sendLogin(s.broker, s.channel, `Login needed: your Zerodha login has ended, so the "${s.name}" report is waiting. Open this link and sign in; the report follows right away.`);
      throw new Error("Login needed.");
    }
    if (!r.ok) throw new Error(r.error);
    const sent = await this.d.channels.send(s.channel, "me", r.text);
    if (!sent.ok) throw new Error(sent.error);
  }

  /** Sends the login link once a day. */
  private async sendLogin(id: string, channel: Schedule["channel"], lead: string): Promise<void> {
    const day = this.today();
    if (this.linkDay === day) return;
    const url = this.loginLink(id);
    if (!url) return;
    const sent = await this.d.channels.send(channel, "me", `${lead}\n${url}`);
    if (sent.ok) this.linkDay = day;
  }

  /** Called every minute: the login reminder, then whatever reports are due. */
  async tick(now: Date): Promise<void> {
    await this.remind(now).catch(() => {});
    await this.scheduler.tick(now);
  }

  private async remind(now: Date): Promise<void> {
    const lead = this.d.config.brokers.loginReminderMinutes;
    if (lead <= 0) return;
    const zone = this.d.config.brokers.timezone;
    const day = localDay(now, zone);
    if (this.d.config.brokers.skipDates.includes(day)) return;
    const weekday = localWeekday(now, zone);
    const due = this.schedules
      .list()
      .filter((s) => s.enabled && this.providers.has(s.broker) && s.days.includes(weekday) && s.lastRunDay !== day)
      .sort((a, b) => a.time.localeCompare(b.time));
    const first = due[0];
    if (!first || this.status(first.broker).loggedIn) return;
    if (minutes(localTime(now, zone)) < minutes(first.time) - lead) return;
    await this.sendLogin(first.broker, first.channel, `Please log in to Zerodha: your ${first.name} report is due at ${first.time}. It takes a minute.`);
  }
}
