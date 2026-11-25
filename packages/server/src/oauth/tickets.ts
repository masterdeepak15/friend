import { randomBytes } from "node:crypto";

const TTL_MS = 10 * 60_000;
const MAX_WAITING = 20;

interface Item {
  key: string;
  extra: Record<string, string>;
  at: number;
}

const make = (): string => randomBytes(24).toString("base64url");

/** Single-use values that tie a return to a login Friend started: approval links (tickets) and the `state` sent to the service. Ten minutes, twenty waiting at most. */
export class OAuthTickets {
  private tickets = new Map<string, Item>();
  private states = new Map<string, Item>();

  constructor(private clock: () => number = Date.now) {}

  private put(map: Map<string, Item>, key: string, extra: Record<string, string>): string {
    const id = make();
    map.set(id, { key, extra, at: this.clock() });
    while (map.size > MAX_WAITING) map.delete(map.keys().next().value as string);
    return id;
  }

  private take(map: Map<string, Item>, id: unknown): Item | null {
    const item = typeof id === "string" ? map.get(id) : undefined;
    if (!item) return null;
    map.delete(id as string);
    return this.clock() - item.at > TTL_MS ? null : item;
  }

  issueTicket(key: string): string {
    return this.put(this.tickets, key, {});
  }

  takeTicket(ticket: string): string | null {
    return this.take(this.tickets, ticket)?.key ?? null;
  }

  issueState(key: string, extra: Record<string, string> = {}): string {
    return this.put(this.states, key, extra);
  }

  takeState(state: string): { key: string; extra: Record<string, string> } | null {
    const i = this.take(this.states, state);
    return i ? { key: i.key, extra: i.extra } : null;
  }
}
