import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { Audit } from "./audit";
import { UnlockStore } from "./auditApi";
import { loadConfig } from "./config";
import { FakeProvider } from "./provider/fake";
import { refuseForAgent, settingsView } from "./settings";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App | undefined;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "friend-audit-api-"));
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [] }, pluginCatalogDir: join(dir, "none") });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const unlock = async (cookie: string, pin = owner.pin) => fetch(base() + "/api/audit/unlock", { method: "POST", headers: { ...j, cookie }, body: JSON.stringify({ pin }) });
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

describe("the audit routes need the owner and the PIN", () => {
  it("no session is 401; a session without the unlock is 403 and says it is locked", async () => {
    const cookie = await boot();
    expect((await fetch(base() + "/api/audit")).status).toBe(401);
    for (const path of ["/api/audit", "/api/audit/attention", "/api/audit/verify", "/api/audit/status", "/api/audit/request/x"]) {
      const res = await fetch(base() + path, { headers: { cookie } });
      expect(res.status, path).toBe(403);
      expect(await res.json()).toMatchObject({ error: "locked" });
    }
  });

  it("a wrong PIN does not unlock and counts toward the lockout; the right PIN gives a token that opens it", async () => {
    const cookie = await boot();
    const statuses: number[] = [];
    for (let i = 0; i < 6; i++) statuses.push((await unlock(cookie, "000000")).status);
    expect(statuses[0]).toBe(403);
    expect(statuses).toContain(429); // locked out after a few wrong ones, like everywhere else
    expect((await unlock(cookie, owner.pin)).status).toBe(429); // and the right PIN does not get in while locked
  });

  it("the unlock token opens the reads, which are themselves written to the trail", async () => {
    const cookie = await boot();
    const u = await unlock(cookie);
    expect(u.status).toBe(200);
    const { token, expiresAt } = (await u.json()) as { token: string; expiresAt: number };
    expect(token).toMatch(/^[0-9a-f]{64}$/);
    expect(expiresAt).toBeGreaterThan(Date.now());
    const h = { cookie, "x-audit-unlock": token };
    const list = (await (await fetch(base() + "/api/audit?limit=5", { headers: h })).json()) as { rows: { kind: string }[]; counts: { total: number } };
    expect(list.rows.length).toBeGreaterThan(0);
    expect(list.counts.total).toBeGreaterThan(0);
    expect((await fetch(base() + "/api/audit/verify", { headers: h }).then((r) => r.json())) as { ok: boolean }).toMatchObject({ ok: true });
    const status = (await (await fetch(base() + "/api/audit/status", { headers: h })).json()) as { rows: number; keepDays: number; workers: unknown[] };
    expect(status).toMatchObject({ keepDays: 90, workers: [] });
    expect(status.rows).toBeGreaterThan(0);
    const reads = new Audit(app!.db).list(50).filter((r) => r.kind === "audit.read");
    expect(reads.length).toBeGreaterThanOrEqual(3);
    expect(reads[0]).toMatchObject({ actorKind: "owner" });
    expect(await (await fetch(base() + "/api/audit/attention", { headers: h })).json()).toHaveProperty("rows");
    expect(await (await fetch(base() + "/api/audit/request/chat-none", { headers: h })).json()).toEqual({ tree: [] });
  });

  it("gives the current seal and checks one: a real one passes, one with another fingerprint fails", async () => {
    const cookie = await boot();
    const { token } = (await (await unlock(cookie)).json()) as { token: string };
    const h = { ...j, cookie, "x-audit-unlock": token };
    const { text } = (await (await fetch(base() + "/api/audit/seal", { headers: h })).json()) as { text: string };
    expect(text).toMatch(/^Friend audit seal \d{4}-\d{2}-\d{2}: rows 1-\d+, hash [0-9a-f]{64}$/);
    const ok = await fetch(base() + "/api/audit/verify-seal", { method: "POST", headers: h, body: JSON.stringify({ text }) });
    expect(await ok.json()).toEqual({ ok: true });
    const bad = await fetch(base() + "/api/audit/verify-seal", { method: "POST", headers: h, body: JSON.stringify({ text: text.replace(/hash [0-9a-f]{4}/, "hash ffff") }) });
    expect(await bad.json()).toMatchObject({ ok: false });
    expect((await fetch(base() + "/api/audit/verify-seal", { method: "POST", headers: h, body: JSON.stringify({}) })).status).toBe(400);
  });

  it("exports a range as JSON, CSV and HTML, as a download, and refuses an unknown format", async () => {
    const cookie = await boot();
    const { token } = (await (await unlock(cookie)).json()) as { token: string };
    const h = { cookie, "x-audit-unlock": token };
    const json = await fetch(base() + "/api/audit/export?format=json", { headers: h });
    expect(json.status).toBe(200);
    expect(json.headers.get("content-disposition")).toMatch(/^attachment; filename="friend-audit-\d{4}-\d{2}-\d{2}\.json"$/);
    expect(json.headers.get("cache-control")).toBe("no-store");
    const body = (await json.json()) as { verify: { ok: boolean }; rows: { id: number }[] };
    expect(body.verify.ok).toBe(true);
    expect(body.rows.length).toBeGreaterThan(0);
    expect(body.rows.map((r) => r.id)).toEqual([...body.rows.map((r) => r.id)].sort((a, b) => a - b)); // oldest first
    const csv = await fetch(base() + "/api/audit/export?format=csv&group=logins", { headers: h });
    expect(csv.headers.get("content-type")).toMatch(/^text\/csv/);
    expect((await csv.text()).split(/\r?\n/)[1]).toMatch(/^id,time,/);
    const html = await fetch(base() + "/api/audit/export?format=html", { headers: h });
    expect(html.headers.get("content-security-policy")).toContain("default-src 'none'");
    expect(await html.text()).toContain("Friend audit report");
    expect((await fetch(base() + "/api/audit/export?format=pdf", { headers: h })).status).toBe(400);
    expect((await fetch(base() + "/api/audit/export", { headers: h })).status).toBe(400);
  });

  it("filters come from the query string, and a bad value is refused", async () => {
    const cookie = await boot();
    const { token } = (await (await unlock(cookie)).json()) as { token: string };
    const h = { cookie, "x-audit-unlock": token };
    const login = (await (await fetch(base() + "/api/audit?group=logins&actorKind=owner", { headers: h })).json()) as { rows: { kind: string; actorKind: string }[] };
    expect(login.rows.length).toBeGreaterThan(0);
    expect(login.rows.every((r) => r.actorKind === "owner")).toBe(true);
    expect((await fetch(base() + "/api/audit?group=nonsense", { headers: h })).status).toBe(400);
    expect((await fetch(base() + "/api/audit?limit=abc", { headers: h })).status).toBe(400);
    expect((await fetch(base() + "/api/audit?q=" + "x".repeat(300), { headers: h })).status).toBe(400);
  });

  it("there is no route that changes or removes an entry", async () => {
    const cookie = await boot();
    const { token } = (await (await unlock(cookie)).json()) as { token: string };
    const h = { ...j, cookie, "x-audit-unlock": token };
    for (const method of ["PUT", "PATCH", "DELETE", "POST"]) {
      for (const path of ["/api/audit", "/api/audit/1", "/api/audit/request/x"]) {
        const res = await fetch(base() + path, method === "DELETE" ? { method, headers: { cookie, "x-audit-unlock": token } } : { method, headers: h, body: "{}" });
        expect([404, 405], `${method} ${path}`).toContain(res.status);
      }
    }
  });

  it("from this PC the command line may give the PIN itself, but never through a proxy", async () => {
    await boot();
    const ok = await fetch(base() + "/api/audit/verify", { headers: { "x-owner-pin": owner.pin } });
    expect(ok.status).toBe(200);
    const proxied = await fetch(base() + "/api/audit/verify", { headers: { "x-owner-pin": owner.pin, "x-forwarded-for": "8.8.8.8" } });
    expect(proxied.status).toBe(401);
    expect((await fetch(base() + "/api/audit/verify", { headers: { "x-owner-pin": "000000" } })).status).toBe(403);
  });
});

describe("the unlock tokens", () => {
  it("expire, and are random", () => {
    let t = 1_000;
    const s = new UnlockStore(() => t);
    const a = s.issue(10);
    const b = s.issue(10);
    expect(a.token).not.toBe(b.token);
    expect(a.expiresAt).toBe(1_000 + 600_000);
    expect(s.valid(a.token)).toBe(true);
    expect(s.valid("nope")).toBe(false);
    t += 600_001;
    expect(s.valid(a.token)).toBe(false);
  });
});

describe("the audit settings", () => {
  it("default to 90 days, archive on, a 09:00 seal and a 10-minute unlock, and the assistant cannot change them", () => {
    const cfg = loadConfig(mkdtempSync(join(tmpdir(), "friend-audit-cfg-")));
    expect(cfg.audit).toEqual({ keepDays: 90, archive: true, sealAt: "09:00", unlockMinutes: 10 });
    expect(settingsView(cfg).audit).toEqual(cfg.audit);
    expect(() => refuseForAgent({ audit: { keepDays: 0 } })).toThrow(/audit/);
  });
});
