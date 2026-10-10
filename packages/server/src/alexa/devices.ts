import type { AlexaConfig } from "../config";

export const MAX_WAITING = 20;
export const MAX_ALLOWED = 10;
const WAITING_TTL_MS = 24 * 3600_000;
const USER_ID = /^amzn1\.ask\.account\.[A-Za-z0-9._-]{8,500}$/;
const SHORT = 8;

interface Waiting {
  id: string;
  deviceShort: string;
  locale: string;
  at: number;
}

export interface AlexaDevicesStore {
  config(): AlexaConfig;
  /** Changes the saved Alexa settings (and the ones in memory) and saves them. */
  update(change: (a: AlexaConfig) => void): void;
}

/**
 * Which Amazon accounts may talk to Friend through Alexa. An account Friend does not know is remembered as "waiting" (in
 * memory only) until the owner allows it with their PIN. The screen only ever sees the last eight characters of an id.
 */
export class AlexaDevices {
  private waitingMap = new Map<string, Waiting>();

  constructor(
    private store: AlexaDevicesStore,
    private clock: () => number = Date.now,
  ) {}

  isAllowed(userId: string): boolean {
    return this.store.config().allowedUsers.some((u) => u.id === userId);
  }

  noteWaiting(userId: string, deviceId: string, locale: string): void {
    if (!USER_ID.test(userId) || this.isAllowed(userId)) return;
    this.prune();
    this.waitingMap.set(userId, { id: userId, deviceShort: String(deviceId).slice(-SHORT), locale: String(locale).slice(0, 10), at: this.clock() });
    while (this.waitingMap.size > MAX_WAITING) {
      const oldest = [...this.waitingMap.values()].sort((a, b) => a.at - b.at)[0]!;
      this.waitingMap.delete(oldest.id);
    }
  }

  waiting(): { short: string; deviceShort: string; locale: string; at: number }[] {
    this.prune();
    return [...this.waitingMap.values()].sort((a, b) => b.at - a.at).map((w) => ({ short: w.id.slice(-SHORT), deviceShort: w.deviceShort, locale: w.locale, at: w.at }));
  }

  allowed(): { short: string; name: string; addedAt: number }[] {
    return this.store.config().allowedUsers.map((u) => ({ short: u.id.slice(-SHORT), name: u.name, addedAt: u.addedAt }));
  }

  /** Moves a waiting account to the allowed list. False when nothing waiting matches, or the list is full. */
  allow(short: string, name: string): boolean {
    this.prune();
    const matches = [...this.waitingMap.values()].filter((w) => short.length === SHORT && w.id.endsWith(short));
    if (matches.length !== 1 || this.store.config().allowedUsers.length >= MAX_ALLOWED) return false;
    const w = matches[0]!;
    const label = name.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, 40) || "Echo";
    this.store.update((a) => a.allowedUsers.push({ id: w.id, name: label, addedAt: this.clock() }));
    this.waitingMap.delete(w.id);
    return true;
  }

  forget(short: string): boolean {
    const found = this.store.config().allowedUsers.filter((u) => short.length === SHORT && u.id.endsWith(short));
    if (found.length !== 1) return false;
    this.store.update((a) => {
      a.allowedUsers = a.allowedUsers.filter((u) => u.id !== found[0]!.id);
    });
    return true;
  }

  private prune(): void {
    const limit = this.clock() - WAITING_TTL_MS;
    for (const [id, w] of this.waitingMap) if (w.at < limit) this.waitingMap.delete(id);
  }
}
