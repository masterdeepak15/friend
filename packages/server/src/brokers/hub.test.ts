import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Audit } from "../audit";
import type { SendResult } from "../channels/hub";
import { loadConfig } from "../config";
import { openDb } from "../db";
import { BrokerHub } from "./hub";
import { BrokerSessions } from "./session";
import { FakeKite } from "./testing/fakeKite";

/** Monday 12 October 2026 at the given India time (IST is UTC+5:30). */
const ist = (hh: number, mm: number, day = 12) => new Date(Date.UTC(2026, 9, day, hh, mm) - 5.5 * 3600_000);

function setup(over: { reminder?: number; installed?: boolean; enabled?: boolean; key?: string; secret?: string | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "friend-brokerhub-"));
  const config = loadConfig(dir);
  config.brokers.zerodha = { installed: over.installed ?? true, enabled: over.enabled ?? true, apiKey: over.key ?? "KEY", apiSecret: over.secret === undefined ? "SECRET" : over.secret };
  config.brokers.loginReminderMinutes = over.reminder ?? 15;
  const db = openDb(dir);
  const kite = new FakeKite();
  const sent: { channel: string; to: string; text: string }[] = [];
  let now = ist(9, 0).getTime();
  const hub = new BrokerHub({
    config,
    dataDir: dir,
    db,
    audit: new Audit(db),
    channels: { send: async (channel, to, text): Promise<SendResult> => (sent.push({ channel, to, text }), { ok: true, summary: "sent" }) },
    clock: () => now,
    fetch: kite.fetch,
    publicBase: () => "https://friend.example.com",
  });
  hub.apply();
  const schedule = () => hub.schedules.add({ name: "Morning", broker: "zerodha", kind: "morning", time: "09:30", days: [1, 2, 3, 4, 5], channel: "telegram", commentary: false, enabled: true });
  /** Starts and finishes a login, like the owner tapping the link. */
  const login = async () => {
    const state = new URL(hub.loginLink("zerodha")!).searchParams.get("redirect_params")!.replace("state=", "");
    return hub.completeLogin({ request_token: kite.issueRequestToken(), state });
  };
  return { hub, kite, sent, dir, db, config, schedule, login, setNow: (d: Date) => (now = d.getTime()), sessions: new BrokerSessions(dir, () => now) };
}

describe("the login link", () => {
  it("carries a one-time state and Friend's return address is shown for the owner to register", () => {
    const { hub } = setup();
    const url = hub.loginLink("zerodha")!;
    expect(url).toMatch(/^https:\/\/kite\.zerodha\.com\/connect\/login\?v=3&api_key=KEY&redirect_params=state%3D[0-9a-f]{48}$/);
    expect(hub.redirectUrl("zerodha")).toBe("https://friend.example.com/api/brokers/zerodha/callback");
  });

  it("is not offered when the plugin is off, not installed, or has no key or secret", () => {
    expect(setup({ enabled: false }).hub.loginLink("zerodha")).toBeNull();
    expect(setup({ installed: false }).hub.loginLink("zerodha")).toBeNull();
    expect(setup({ key: "" }).hub.loginLink("zerodha")).toBeNull();
    expect(setup({ secret: null }).hub.loginLink("zerodha")).toBeNull();
    expect(setup().hub.loginLink("angelone")).toBeNull();
  });
});

describe("finishing a login", () => {
  it("with the right state and code stores the session and the account can be read", async () => {
    const { hub, sessions, login } = setup();
    expect(hub.status("zerodha")).toMatchObject({ loggedIn: false, detail: expect.stringMatching(/Login needed/) });
    expect(await login()).toEqual({ ok: true });
    expect(hub.status("zerodha")).toMatchObject({ installed: true, enabled: true, keySet: true, secretSet: true, loggedIn: true });
    expect(hub.status("zerodha").expiresAt).toBeGreaterThan(0);
    expect(sessions.load("zerodha")?.accessToken).toBe("ACCESS-1");
    const r = await hub.report("zerodha");
    expect(r).toMatchObject({ ok: true, text: expect.stringContaining("Portfolio: ₹") });
  });

  it("remembers the login after a restart", async () => {
    const { hub, login, config, dir, db, kite } = setup();
    await login();
    const again = new BrokerHub({ config, dataDir: dir, db, audit: new Audit(db), channels: { send: async () => ({ ok: true, summary: "" }) }, fetch: kite.fetch, publicBase: () => null });
    again.apply();
    expect(again.status("zerodha").loggedIn).toBe(true);
  });

  it("refuses a replayed, wrong, missing, expired or broker-rejected login and stores nothing", async () => {
    const { hub, kite, sessions, setNow } = setup();
    const stateOf = () => new URL(hub.loginLink("zerodha")!).searchParams.get("redirect_params")!.replace("state=", "");

    const state = stateOf();
    expect((await hub.completeLogin({ request_token: kite.issueRequestToken(), state })).ok).toBe(true);
    kite.tokenValid = true;
    // replay of the same state
    expect((await hub.completeLogin({ request_token: kite.issueRequestToken(), state })).ok).toBe(false);
    sessions.clear("zerodha");
    hub.apply();

    expect((await hub.completeLogin({ request_token: kite.issueRequestToken(), state: "0".repeat(48) })).ok).toBe(false); // wrong
    expect((await hub.completeLogin({ request_token: kite.issueRequestToken() })).ok).toBe(false); // missing
    const stale = stateOf();
    setNow(ist(9, 11));
    expect((await hub.completeLogin({ request_token: kite.issueRequestToken(), state: stale })).ok).toBe(false); // expired (clock moved on)
    setNow(ist(9, 0));
    expect((await hub.completeLogin({ request_token: "forged", state: stateOf() })).ok).toBe(false); // the broker says no
    expect(sessions.load("zerodha")).toBeNull();
    expect(hub.status("zerodha").loggedIn).toBe(false);
  });
});

describe("a report that falls due", () => {
  it("sends the login link, no figures, when the login has expired, and the report once the owner logs in", async () => {
    const { hub, sent, schedule, login, setNow } = setup();
    const s = schedule();
    setNow(ist(9, 30));
    await expect(hub.deliver(s)).rejects.toThrow(/login/i);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ channel: "telegram", to: "me" });
    expect(sent[0]!.text).toMatch(/Login needed/);
    expect(sent[0]!.text).toContain("https://kite.zerodha.com/connect/login");
    expect(sent[0]!.text).not.toContain("₹");
    expect(hub.schedules.list()[0]!.lastRunDay).toBeNull(); // nothing is marked as run

    await expect(hub.deliver(s)).rejects.toThrow(); // asked again in the same day: not another link
    expect(sent).toHaveLength(1);

    await login();
    expect(sent).toHaveLength(2); // the pending report follows
    expect(sent[1]!.text).toContain("Morning report - Zerodha - Mon 12 Oct");
    expect(sent[1]!.text).toContain("Portfolio: ₹");
    expect(hub.schedules.list()[0]!.lastRunDay).toBe("2026-10-12");
  });

  it("still follows the login after the scheduler has given up for the day", async () => {
    const { hub, sent, schedule, login, setNow } = setup();
    schedule();
    for (const m of [30, 31, 32, 33, 34]) {
      setNow(ist(9, m));
      await hub.tick(ist(9, m));
    }
    expect(sent).toHaveLength(1); // one login link, however many tries
    await login();
    expect(sent).toHaveLength(2);
    expect(sent[1]!.text).toContain("Portfolio: ₹");
  });

  it("still goes out when one part cannot be read, and says which", async () => {
    const { hub, sent, schedule, login, kite, setNow } = setup();
    const s = schedule();
    await login();
    setNow(ist(9, 30));
    kite.failNext("/portfolio/positions", 429);
    await hub.deliver(s);
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("Portfolio: ₹");
    expect(sent[0]!.text).toContain("Positions: not available (rate limit)");
  });

  it("is a login request when the session ended in the middle of the day", async () => {
    const { hub, sent, schedule, login, kite, setNow } = setup();
    const s = schedule();
    await login();
    setNow(ist(9, 30));
    kite.tokenValid = false; // Zerodha ended the session
    await expect(hub.deliver(s)).rejects.toThrow(/login/i);
    expect(sent[0]!.text).toMatch(/Login needed/);
    expect(sent[0]!.text).not.toContain("₹");
  });

  it("throws when the message app refuses, so the scheduler tries again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-brokerhub-"));
    const config = loadConfig(dir);
    config.brokers.zerodha = { installed: true, enabled: true, apiKey: "KEY", apiSecret: "SECRET" };
    const db = openDb(dir);
    const kite = new FakeKite();
    const hub = new BrokerHub({ config, dataDir: dir, db, audit: new Audit(db), channels: { send: async () => ({ ok: false, error: "Telegram is not switched on." }) }, fetch: kite.fetch, publicBase: () => null });
    hub.apply();
    const state = new URL(hub.loginLink("zerodha")!).searchParams.get("redirect_params")!.replace("state=", "");
    await hub.completeLogin({ request_token: kite.issueRequestToken(), state });
    const s = hub.schedules.add({ name: "M", broker: "zerodha", kind: "morning", time: "09:30", days: [1], channel: "telegram", commentary: false, enabled: true });
    await expect(hub.deliver(s)).rejects.toThrow(/Telegram is not switched on/);
    expect(hub.schedules.list()[0]!.lastRunDay).toBeNull();
  });
});

describe("the login reminder before the first report", () => {
  it("is sent once, 15 minutes before the earliest report of the day, if the owner is not logged in", async () => {
    const { hub, sent, schedule, setNow } = setup();
    schedule();
    setNow(ist(9, 14));
    await hub.tick(ist(9, 14));
    expect(sent).toHaveLength(0);
    await hub.tick(ist(9, 15));
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toMatch(/log in to Zerodha/i);
    expect(sent[0]!.text).toContain("https://kite.zerodha.com/connect/login");
    await hub.tick(ist(9, 16));
    await hub.tick(ist(9, 20));
    expect(sent).toHaveLength(1);
  });

  it("is not sent when it is switched off, when the owner is already logged in, or on a day with no report", async () => {
    const off = setup({ reminder: 0 });
    off.schedule();
    await off.hub.tick(ist(9, 20));
    expect(off.sent).toHaveLength(0);

    const logged = setup();
    logged.schedule();
    await logged.login();
    await logged.hub.tick(ist(9, 20));
    expect(logged.sent).toHaveLength(0);

    const weekend = setup();
    weekend.schedule();
    await weekend.hub.tick(ist(9, 20, 10)); // Saturday
    expect(weekend.sent).toHaveLength(0);
  });
});

describe("what is recorded", () => {
  it("keeps only the kind and size of a report, never amounts, the token or the secret", async () => {
    const { hub, schedule, login, kite, db, setNow } = setup();
    const s = schedule();
    await login();
    setNow(ist(9, 30));
    await hub.deliver(s);
    kite.tokenValid = false;
    await hub.report("zerodha").catch(() => {});
    const rows = (db.prepare("select kind, detail_json d from audit_log").all() as { kind: string; d: string }[]).filter((r) => r.kind.startsWith("broker."));
    expect(rows.length).toBeGreaterThan(0);
    for (const r of rows) expect(r.d).not.toMatch(/ACCESS-1|SECRET|50000|1600|3000|₹/);
    expect(rows.map((r) => r.kind)).toEqual(expect.arrayContaining(["broker.login", "broker.report"]));
  });
});

describe("a plugin that is not usable", () => {
  it("gives no report and says why", async () => {
    expect(await setup({ enabled: false }).hub.report("zerodha")).toMatchObject({ ok: false, error: expect.stringMatching(/not installed or not switched on/) });
    expect(await setup().hub.report("zerodha")).toMatchObject({ ok: false, sessionExpired: true });
    expect(await setup().hub.report("angelone")).toMatchObject({ ok: false });
  });
});
