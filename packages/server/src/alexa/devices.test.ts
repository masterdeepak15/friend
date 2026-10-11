import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AlexaConfig } from "../config";
import { sanitizeAlexa } from "../config";
import { AlexaDevices, MAX_WAITING } from "./devices";

const user = (n: number) => `amzn1.ask.account.AHUSERABCDEFGHIJKLMNOP${String(n).padStart(8, "0")}`;
let cfg: AlexaConfig;
let now = 0;
const saved = vi.fn();
const make = () => new AlexaDevices({ config: () => cfg, update: (fn) => (fn(cfg), saved()) }, () => now);

beforeEach(() => {
  cfg = { ...sanitizeAlexa({}), installed: true, enabled: true };
  now = 1_000_000;
  saved.mockClear();
});

describe("who is waiting", () => {
  it("lists an unknown Echo once, however many times it asks, with the newest time", () => {
    const d = make();
    d.noteWaiting(user(1), "amzn1.ask.device.AAAA1111BBBB", "en-IN");
    now += 5000;
    d.noteWaiting(user(1), "amzn1.ask.device.AAAA1111BBBB", "en-IN");
    expect(d.waiting()).toHaveLength(1);
    expect(d.waiting()[0]).toMatchObject({ short: user(1).slice(-8), locale: "en-IN", at: now });
    expect(JSON.stringify(d.waiting())).not.toContain(user(1));
  });

  it("keeps at most twenty, dropping the oldest, and forgets those older than a day", () => {
    const d = make();
    for (let i = 0; i < MAX_WAITING + 5; i++) {
      now += 1000;
      d.noteWaiting(user(i), "dev", "en-IN");
    }
    expect(d.waiting()).toHaveLength(MAX_WAITING);
    expect(d.waiting().some((w) => w.short === user(0).slice(-8))).toBe(false);
    now += 25 * 3600_000;
    expect(d.waiting()).toHaveLength(0);
  });

  it("ignores something that is not an Amazon user id", () => {
    const d = make();
    d.noteWaiting("<script>", "dev", "en-IN");
    d.noteWaiting("", "dev", "en-IN");
    expect(d.waiting()).toHaveLength(0);
  });
});

describe("allowing and forgetting", () => {
  it("allow moves a waiting Echo to the allowed list, saves it, and the Echo is then allowed", () => {
    const d = make();
    d.noteWaiting(user(1), "dev", "en-IN");
    expect(d.isAllowed(user(1))).toBe(false);
    expect(d.allow(user(1).slice(-8), "Kitchen")).toBe(true);
    expect(d.isAllowed(user(1))).toBe(true);
    expect(d.waiting()).toHaveLength(0);
    expect(cfg.allowedUsers).toEqual([{ id: user(1), name: "Kitchen", addedAt: now }]);
    expect(saved).toHaveBeenCalled();
  });

  it("cannot allow an Echo that has not asked, or a short id that matches nothing", () => {
    const d = make();
    expect(d.allow("ZZZZZZZZ", "Nobody")).toBe(false);
    expect(cfg.allowedUsers).toHaveLength(0);
  });

  it("allows at most ten", () => {
    const d = make();
    for (let i = 0; i < cfg.maxDevices; i++) {
      d.noteWaiting(user(i), "dev", "en-IN");
      expect(d.allow(user(i).slice(-8), `Echo ${i}`)).toBe(true);
    }
    d.noteWaiting(user(99), "dev", "en-IN");
    expect(d.allow(user(99).slice(-8), "One too many")).toBe(false);
  });

  it("forgets an allowed Echo by its short id", () => {
    const d = make();
    d.noteWaiting(user(1), "dev", "en-IN");
    d.allow(user(1).slice(-8), "Kitchen");
    expect(d.forget(user(1).slice(-8))).toBe(true);
    expect(d.isAllowed(user(1))).toBe(false);
    expect(d.forget(user(1).slice(-8))).toBe(false);
  });

  it("shows allowed Echoes by short id and name", () => {
    const d = make();
    d.noteWaiting(user(1), "dev", "en-IN");
    d.allow(user(1).slice(-8), "Kitchen");
    expect(d.allowed()).toEqual([{ short: user(1).slice(-8), name: "Kitchen", addedAt: now }]);
  });
});
