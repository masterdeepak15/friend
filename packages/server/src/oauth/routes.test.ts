import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { FakeProvider } from "../provider/fake";

let app: Awaited<ReturnType<typeof createApp>>;
afterEach(async () => {
  await app.stop();
});
const j = { "content-type": "application/json" };

async function boot(clients: Record<string, { clientId: string }> = { google: { clientId: "cid-12345678" } }) {
  const calls: { url: string; body: string }[] = [];
  const oauthFetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: String(init.body) });
    if (url.includes("/revoke")) return new Response("{}", { status: 200 });
    const idToken = `a.${Buffer.from(JSON.stringify({ email: "me@example.com" })).toString("base64url")}.c`;
    return new Response(JSON.stringify({ access_token: "SECRET-AT", refresh_token: "SECRET-RT", expires_in: 3600, scope: "openid email", id_token: idToken }), { status: 200 });
  }) as unknown as typeof fetch;
  const dir = mkdtempSync(join(tmpdir(), "friend-oauth-app-"));
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [], publicUrl: "https://maya.example.com", oauth: { clients } }, oauthFetch });
  const port = (await app.start()).port;
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" }) });
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: "correct horse battery" }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const owner = (path: string, init: RequestInit = {}) => fetch(`${base}${path}`, { ...init, headers: { ...j, cookie, origin: base, ...(init.headers ?? {}) } });
  return { base, owner, calls };
}

describe("signing in with a link, over HTTP", () => {
  it("is for the signed-in owner only", async () => {
    const t = await boot();
    expect((await fetch(`${t.base}/api/oauth`)).status).toBe(401);
    expect((await fetch(`${t.base}/api/oauth/services/google/connect`, { method: "POST", headers: j, body: "{}" })).status).toBe(401);
  });

  it("connects a service: link, consent address, return; nothing secret is shown or logged", async () => {
    const t = await boot();
    const state0 = (await (await t.owner("/api/oauth")).json()) as { services: { id: string; configured: boolean; connected: boolean; redirectUri: string }[] };
    expect(state0.services[0]).toMatchObject({ id: "google", configured: true, connected: false, redirectUri: "https://maya.example.com/api/oauth/callback" });

    const { link, sent } = (await (await t.owner("/api/oauth/services/google/connect", { method: "POST", body: JSON.stringify({ toPhone: true }) })).json()) as { link: string; sent: boolean };
    expect(link).toMatch(/^https:\/\/maya\.example\.com\/api\/oauth\/start\//);
    expect(sent).toBe(false); // no phone app is linked in this test

    const start = `${t.base}/api/oauth/start/${link.split("/").pop()}`;
    const go = await fetch(start, { redirect: "manual" });
    expect(go.status).toBe(302);
    const consent = new URL(go.headers.get("location")!);
    expect(consent.origin).toBe("https://accounts.google.com");
    expect(consent.searchParams.get("redirect_uri")).toBe("https://maya.example.com/api/oauth/callback");
    expect((await fetch(start, { redirect: "manual" })).status).toBe(400); // the link works once

    const back = await fetch(`${t.base}/api/oauth/callback?state=${encodeURIComponent(consent.searchParams.get("state")!)}&code=CODE`);
    expect(back.status).toBe(200);
    expect(await back.text()).toContain("Connected");
    const after = (await (await t.owner("/api/oauth")).json()) as { services: { connected: boolean; account: string | null }[] };
    expect(after.services[0]).toMatchObject({ connected: true, account: "me@example.com" });

    const everything = JSON.stringify([after, app.db.prepare("select * from audit_log").all()]);
    for (const s of ["SECRET-AT", "SECRET-RT", "CODE"]) expect(everything).not.toContain(s);
    expect(app.db.prepare("select count(*) as c from audit_log where kind = 'oauth.connected'").get()).toEqual({ c: 1 });
  });

  it("a return with a wrong state connects nothing", async () => {
    const t = await boot();
    const back = await fetch(`${t.base}/api/oauth/callback?state=forged&code=CODE`);
    expect(back.status).toBe(400);
    const s = (await (await t.owner("/api/oauth")).json()) as { services: { connected: boolean }[] };
    expect(s.services[0]!.connected).toBe(false);
    expect(t.calls).toHaveLength(0);
  });

  it("will not start a service the host has not set up, and says what is missing", async () => {
    const t = await boot({});
    const r = await t.owner("/api/oauth/services/google/connect", { method: "POST", body: "{}" });
    expect(r.status).toBe(400);
    expect(((await r.json()) as { error: string }).error).toMatch(/client ID first/);
  });

  it("the client ID needs the PIN, and a new one ends the old login", async () => {
    const t = await boot();
    const put = (body: object) => t.owner("/api/oauth/services/google/client", { method: "PUT", body: JSON.stringify(body) });
    expect((await put({ clientId: "new-client-12345" })).status).toBe(400);
    expect((await put({ clientId: "new-client-12345", pin: "000000" })).status).toBe(403);
    expect((await put({ clientId: "has spaces here", pin: "123456" })).status).toBe(400);
    expect((await put({ clientId: "new-client-12345", clientSecret: "S3CRET-VALUE", pin: "123456" })).status).toBe(200);
    const s = (await (await t.owner("/api/oauth")).json()) as { services: { configured: boolean }[] };
    expect(s.services[0]!.configured).toBe(true);
    const everything = JSON.stringify([s, app.db.prepare("select * from audit_log").all()]);
    expect(everything).not.toContain("S3CRET-VALUE");
  });

  it("disconnect forgets the login and asks the service to forget it too", async () => {
    const t = await boot();
    const { link } = (await (await t.owner("/api/oauth/services/google/connect", { method: "POST", body: "{}" })).json()) as { link: string };
    const go = await fetch(`${t.base}/api/oauth/start/${link.split("/").pop()}`, { redirect: "manual" });
    const state = new URL(go.headers.get("location")!).searchParams.get("state")!;
    await fetch(`${t.base}/api/oauth/callback?state=${encodeURIComponent(state)}&code=CODE`);
    expect((await t.owner("/api/oauth/services/google/disconnect", { method: "POST", body: "{}" })).status).toBe(200);
    const s = (await (await t.owner("/api/oauth")).json()) as { services: { connected: boolean }[] };
    expect(s.services[0]!.connected).toBe(false);
    expect(t.calls.some((c) => c.url.includes("/revoke"))).toBe(true);
  });
});
