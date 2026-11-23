import type { Audit } from "./audit";

/** How the owner wants security alerts to behave. */
export interface SecurityAlertsConfig {
  enabled: boolean;
  /** After an alert about one thing, the same thing is not reported again for this long (what happened meanwhile is added to the next one). */
  cooldownMinutes: number;
  /** The most alerts sent in one day, however many things happen. */
  maxPerDay: number;
}

/** One entry of the audit trail, as the watch sees it. */
export interface AuditEvent {
  kind: string;
  actorKind: string;
  detail: Record<string, unknown>;
  ts: number;
}

interface Rule {
  id: string;
  title: string;
  /** What it means, in the owner's words. */
  what: string;
  kinds: readonly string[];
  /** How many such entries inside `windowSec` make an alert. */
  threshold: number;
  windowSec: number;
  match?: (e: AuditEvent) => boolean;
}

/**
 * What counts as someone trying to get in or to get something they may not have. Each rule is a count over a short time: one wrong
 * PIN is a slip, three are an attempt. These are written down here, not hidden in the code that logs them, so they can be read and tested.
 */
export const SECURITY_RULES: readonly Rule[] = [
  { id: "password", title: "Wrong password", what: "Someone tried a wrong password", kinds: ["login.fail"], threshold: 3, windowSec: 600 },
  { id: "pin", title: "Wrong PIN", what: "Someone entered a wrong PIN", kinds: ["pin.fail", "voice.challenge_failed", "secrets.fail"], threshold: 2, windowSec: 600 },
  { id: "pairing", title: "Pairing code guessed", what: "Someone tried to pair a device with a wrong code", kinds: ["pair.fail"], threshold: 3, windowSec: 600 },
  { id: "stranger", title: "A stranger asked for something private", what: "A voice that is not yours asked Friend to do something only you may", kinds: ["tool.denied"], threshold: 2, windowSec: 600, match: (e) => e.detail.trust === "guest" || e.detail.trust === "member" },
  { id: "camera", title: "Someone tried to use the camera", what: "Someone tried to make Friend use the camera or look at the screen", kinds: ["camera.denied", "camera.look.refused", "screen.denied"], threshold: 2, windowSec: 900 },
  { id: "scan", title: "Unwanted connection attempts", what: "Unwanted connections were refused", kinds: ["host.refused", "ws.origin_refused", "device.refused", "setup.refused", "chrome.remote_refused"], threshold: 8, windowSec: 600 },
  { id: "sender", title: "An unknown sender", what: "An unknown sender tried to talk to Friend", kinds: ["channel.twilio_refused", "alexa.refused"], threshold: 3, windowSec: 900 },
];

const MINUTE = 60_000;
const clock = (d: Date): string => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/**
 * Tells the owner, on their phone only, when someone is trying to break in. It reads the audit trail as it is written, so it needs no
 * help from the code that logs, and nothing a screen, a voice, a page or the model says can switch it off or change what it says.
 * It never touches the screen or the speakers: the person in front of the computer is not told.
 */
export class SecurityWatch {
  private hits = new Map<string, AuditEvent[]>();
  private lastSent = new Map<string, number>();
  private held = new Map<string, number>();
  private day = { key: "", n: 0 };

  constructor(private d: { config: () => SecurityAlertsConfig; send: (text: string) => Promise<string[]>; audit: Pick<Audit, "log">; clock?: () => number }) {}

  private now(): number {
    return (this.d.clock ?? Date.now)();
  }

  /** Called for every audit entry. Never throws. */
  see(e: AuditEvent): void {
    try {
      if (!this.d.config().enabled) return;
      const now = this.now();
      for (const rule of SECURITY_RULES) {
        if (!rule.kinds.includes(e.kind) || (rule.match && !rule.match(e))) continue;
        const list = (this.hits.get(rule.id) ?? []).filter((h) => now - h.ts < rule.windowSec * 1000);
        list.push(e);
        this.hits.set(rule.id, list);
        if (list.length < rule.threshold) continue;
        this.hits.set(rule.id, []);
        const where = [...new Set(list.map((h) => (typeof h.detail.ip === "string" ? h.detail.ip : typeof h.detail.deviceName === "string" ? `device "${h.detail.deviceName}"` : "")).filter(Boolean))].slice(0, 3);
        void this.alert(rule.id, rule.title, `${rule.what} ${list.length} times in the last ${Math.round(rule.windowSec / 60)} minutes${where.length ? ` (from ${where.join(", ")})` : ""}.`, this.d.config().cooldownMinutes).catch(() => {});
      }
    } catch {
      /* watching must never break what is being watched */
    }
  }

  /** Something the owner must know now, without a count: the emergency lock, or the assistant noticed an attempt. Returns where it went. */
  async notify(id: string, title: string, text: string, cooldownMinutes?: number): Promise<{ ok: boolean; sent: string[]; why?: string }> {
    if (!this.d.config().enabled) return { ok: false, sent: [], why: "Security alerts are switched off." };
    return this.alert(id, title, text, cooldownMinutes ?? this.d.config().cooldownMinutes);
  }

  private async alert(id: string, title: string, text: string, cooldownMinutes: number): Promise<{ ok: boolean; sent: string[]; why?: string }> {
    const cfg = this.d.config();
    const now = this.now();
    const last = this.lastSent.get(id);
    if (last !== undefined && now - last < cooldownMinutes * MINUTE) {
      this.held.set(id, (this.held.get(id) ?? 0) + 1); // reported with the next one
      return { ok: false, sent: [], why: "The owner was told about this a moment ago." };
    }
    const key = new Date(now).toISOString().slice(0, 10);
    if (this.day.key !== key) this.day = { key, n: 0 };
    if (this.day.n >= cfg.maxPerDay) return { ok: false, sent: [], why: "The limit of alerts for today was reached." };
    this.day.n++;
    this.lastSent.set(id, now);
    const more = this.held.get(id) ?? 0;
    this.held.delete(id);
    const body = `⚠ Friend security alert: ${title}\n${text}${more ? `\n(${more} more since the last alert about this.)` : ""}\nTime: ${clock(new Date(now))}. Only you got this message; nothing was shown or said on the screen.`;
    try {
      const sent = await this.d.send(body);
      this.d.audit.log("system", sent.length ? "security.alert" : "security.alert_unsent", { rule: id, sent });
      return { ok: sent.length > 0, sent, ...(sent.length ? {} : { why: "No phone app is linked." }) };
    } catch {
      this.d.audit.log("system", "security.alert_failed", { rule: id });
      return { ok: false, sent: [], why: "The message could not be sent." };
    }
  }
}
