import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BrokerSessions } from "./session";

const dir = () => mkdtempSync(join(tmpdir(), "friend-sessions-"));
const clockAt = (start: number) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
};

describe("the daily access token", () => {
  it("is saved and read back", () => {
    const s = new BrokerSessions(dir());
    s.save("zerodha", { accessToken: "T1", expiresAt: Date.now() + 3600_000 });
    expect(s.load("zerodha")).toMatchObject({ accessToken: "T1" });
    expect(s.load("angelone")).toBeNull();
  });

  it("lives in its own file, readable only by the owner where the system allows it", () => {
    const d = dir();
    new BrokerSessions(d).save("zerodha", { accessToken: "T1", expiresAt: Date.now() + 3600_000 });
    const file = join(d, "broker-zerodha.session.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8")).accessToken).toBe("T1");
    if (process.platform !== "win32") expect(statSync(file).mode & 0o777).toBe(0o600);
  });

  it("is gone once it has expired, and the file is deleted", () => {
    const d = dir();
    const c = clockAt(1_000_000);
    const s = new BrokerSessions(d, c.now);
    s.save("zerodha", { accessToken: "T1", expiresAt: 1_000_000 + 1000 });
    c.advance(1001);
    expect(s.load("zerodha")).toBeNull();
    expect(readdirSync(d)).toEqual([]);
  });

  it("is removed on request", () => {
    const d = dir();
    const s = new BrokerSessions(d);
    s.save("zerodha", { accessToken: "T1", expiresAt: Date.now() + 3600_000 });
    s.clear("zerodha");
    expect(s.load("zerodha")).toBeNull();
    expect(readdirSync(d)).toEqual([]);
  });

  it("does not choke on a damaged file or an odd broker id", () => {
    const d = dir();
    const s = new BrokerSessions(d);
    s.save("zerodha", { accessToken: "T1", expiresAt: Date.now() + 3600_000 });
    expect(() => s.save("../../evil", { accessToken: "x", expiresAt: Date.now() + 1000 })).toThrow(/broker id/);
    expect(s.load("../../evil")).toBeNull();
    // a damaged file reads as no session
    new BrokerSessions(d).save("zerodha", { accessToken: "T1", expiresAt: Date.now() + 3600_000 });
    writeFileSync(join(d, "broker-zerodha.session.json"), "{not json");
    expect(s.load("zerodha")).toBeNull();
  });
});

describe("one-time login states", () => {
  it("are long and random, and work once for the broker they were made for", () => {
    const s = new BrokerSessions(dir());
    const state = s.newState("zerodha");
    expect(state).toMatch(/^[0-9a-f]{32,}$/);
    expect(s.newState("zerodha")).not.toBe(state);
    expect(s.takeState(state)).toBe("zerodha");
    expect(s.takeState(state)).toBeNull(); // a replay fails
  });

  it("expire after ten minutes", () => {
    const c = clockAt(5_000_000);
    const s = new BrokerSessions(dir(), c.now);
    const state = s.newState("zerodha");
    c.advance(10 * 60_000 + 1);
    expect(s.takeState(state)).toBeNull();
    const fresh = s.newState("zerodha");
    c.advance(9 * 60_000);
    expect(s.takeState(fresh)).toBe("zerodha");
  });

  it("refuse anything that was not made by Friend", () => {
    const s = new BrokerSessions(dir());
    s.newState("zerodha");
    for (const bad of ["", "abc", "0".repeat(32), "x".repeat(500), undefined as unknown as string]) expect(s.takeState(bad)).toBeNull();
  });

  it("keep at most twenty waiting, dropping the oldest", () => {
    const s = new BrokerSessions(dir());
    const first = s.newState("zerodha");
    for (let i = 0; i < 20; i++) s.newState("zerodha");
    expect(s.takeState(first)).toBeNull();
  });
});
