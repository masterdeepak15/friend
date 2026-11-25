import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OAuthHub } from "./hub";

function rig(over: { clients?: Record<string, { clientId: string }>; publicUrl?: string | null; tokenReply?: (body: string) => { status: number; json: object } } = {}) {
  let now = 1_000_000;
  const audit: { kind: string; details: object }[] = [];
  const sent: string[] = [];
  const calls: { url: string; body: string }[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const body = String(init.body);
    calls.push({ url, body });
    if (url.includes("/revoke")) return new Response("{}", { status: 200 });
    const r = over.tokenReply?.(body) ?? { status: 200, json: { access_token: "AT1", refresh_token: "RT1", expires_in: 3600, scope: "openid email", id_token: `a.${Buffer.from(JSON.stringify({ email: "me@example.com" })).toString("base64url")}.c` } };
    return new Response(JSON.stringify(r.json), { status: r.status });
  }) as unknown as typeof fetch;
  const hub = new OAuthHub({
    dataDir: mkdtempSync(join(tmpdir(), "friend-oauth-")),
    config: () => ({ publicUrl: over.publicUrl === undefined ? "https://maya.example.com" : over.publicUrl, port: 8787, oauth: { clients: over.clients ?? { google: { clientId: "cid" } } } }),
    audit: { log: (_w, kind, details) => audit.push({ kind, details }) },
    send: async (t) => (sent.push(t), true),
    fetch: f,
    clock: () => now,
  });
  return { hub, audit, sent, calls, advance: (ms: number) => (now += ms) };
}

async function connect(r: ReturnType<typeof rig>) {
  const { link } = await r.hub.startService("google");
  const consent = new URL(r.hub.openTicket(link.split("/").pop()!)!);
  const res = await r.hub.callback({ state: consent.searchParams.get("state")!, code: "CODE" });
  return { consent, res };
}

describe("OAuthHub, a known service", () => {
  it("connects through a link: start, open, return", async () => {
    const r = rig();
    const { consent, res } = await connect(r);
    expect(consent.origin).toBe("https://accounts.google.com");
    expect(consent.searchParams.get("redirect_uri")).toBe("https://maya.example.com/api/oauth/callback");
    expect(res).toEqual({ ok: true, key: "svc:google" });
    expect(r.hub.services()[0]).toMatchObject({ id: "google", configured: true, connected: true, needsReconnect: false, account: "me@example.com" });
    expect(await r.hub.accessToken("google")).toBe("AT1");
  });

  it("uses the host's own address, so another host gets its own return address", async () => {
    const r = rig({ publicUrl: "https://other.test" });
    expect(r.hub.services()[0]!.redirectUri).toBe("https://other.test/api/oauth/callback");
    expect((await r.hub.startService("google")).link.startsWith("https://other.test/api/oauth/start/")).toBe(true);
  });

  it("will not start without the host's client ID, and says what to add", async () => {
    const r = rig({ clients: {} });
    expect(r.hub.services()[0]).toMatchObject({ configured: false, connected: false });
    await expect(r.hub.startService("google")).rejects.toThrow(/client ID first/);
  });

  it("a link works once and only for ten minutes", async () => {
    const r = rig();
    const t = (await r.hub.startService("google")).link.split("/").pop()!;
    expect(r.hub.openTicket(t)).not.toBeNull();
    expect(r.hub.openTicket(t)).toBeNull();
    const t2 = (await r.hub.startService("google")).link.split("/").pop()!;
    r.advance(10 * 60_000 + 1);
    expect(r.hub.openTicket(t2)).toBeNull();
  });

  it("a return with an unknown, replayed or expired state saves nothing", async () => {
    const r = rig();
    expect(await r.hub.callback({ state: "nope", code: "C" })).toEqual({ ok: false });
    const { consent } = await connect(r);
    const state = consent.searchParams.get("state")!;
    expect(await r.hub.callback({ state, code: "C" })).toEqual({ ok: false }); // already used
    const r2 = rig();
    const t = (await r2.hub.startService("google")).link.split("/").pop()!;
    const s2 = new URL(r2.hub.openTicket(t)!).searchParams.get("state")!;
    r2.advance(10 * 60_000 + 1);
    expect(await r2.hub.callback({ state: s2, code: "C" })).toEqual({ ok: false });
    expect(r2.hub.services()[0]!.connected).toBe(false);
  });

  it("a return from the wrong issuer or with an error saves nothing", async () => {
    const r = rig();
    const t = (await r.hub.startService("google")).link.split("/").pop()!;
    const s = new URL(r.hub.openTicket(t)!).searchParams.get("state")!;
    expect((await r.hub.callback({ state: s, code: "C", iss: "https://evil.example" })).ok).toBe(false);
    const t2 = (await r.hub.startService("google")).link.split("/").pop()!;
    const s2 = new URL(r.hub.openTicket(t2)!).searchParams.get("state")!;
    expect((await r.hub.callback({ state: s2, error: "access_denied" })).ok).toBe(false);
    expect(r.hub.services()[0]!.connected).toBe(false);
  });

  it("sends the link to the phone when asked, and only the link", async () => {
    const r = rig();
    const out = await r.hub.startService("google", { toPhone: true });
    expect(out.sent).toBe(true);
    expect(r.sent).toHaveLength(1);
    expect(r.sent[0]).toContain(out.link);
  });

  it("renews the login shortly before it ends, one renewal for simultaneous callers", async () => {
    const r = rig();
    await connect(r);
    r.advance(3600_000 - 30_000);
    const refreshCalls = () => r.calls.filter((c) => c.body.includes("grant_type=refresh_token")).length;
    r.hub["f"] = (async (_u: string, init: RequestInit) => {
      r.calls.push({ url: _u, body: String(init.body) });
      return new Response(JSON.stringify({ access_token: "AT2", expires_in: 3600 }), { status: 200 });
    }) as unknown as typeof fetch;
    const [a, b] = await Promise.all([r.hub.accessToken("google"), r.hub.accessToken("google")]);
    expect([a, b]).toEqual(["AT2", "AT2"]);
    expect(refreshCalls()).toBe(1);
  });

  it("when the service refuses the renewal the owner is told once and has to connect again", async () => {
    const r = rig();
    await connect(r);
    r.advance(3600_000);
    r.hub["f"] = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as typeof fetch;
    expect(await r.hub.accessToken("google")).toBeNull();
    expect(await r.hub.accessToken("google")).toBeNull();
    expect(r.hub.services()[0]).toMatchObject({ needsReconnect: true });
    expect(r.sent).toHaveLength(1);
    expect(r.audit.some((a) => a.kind === "oauth.refresh.failed")).toBe(true);
  });

  it("a hiccup on renewal waits before trying again and does not end the login", async () => {
    const r = rig();
    await connect(r);
    r.advance(3600_000);
    let n = 0;
    r.hub["f"] = (async () => (n++, new Response("{}", { status: 503 }))) as unknown as typeof fetch;
    expect(await r.hub.accessToken("google")).toBeNull();
    expect(await r.hub.accessToken("google")).toBeNull();
    expect(n).toBe(1);
    expect(r.hub.services()[0]!.needsReconnect).toBe(false);
  });

  it("disconnect tells the service, forgets the login, keeps the host's secret", async () => {
    const r = rig();
    r.hub.setClientSecret("google", "SECRET");
    await connect(r);
    await r.hub.disconnect("svc:google");
    expect(r.calls.some((c) => c.url.includes("/revoke") && c.body.includes("RT1"))).toBe(true);
    expect(r.hub.services()[0]!.connected).toBe(false);
    expect(r.hub.vault.get("svc:google").clientSecret).toBe("SECRET");
  });

  it("no audit row, message or thrown text carries a token, a code or a secret", async () => {
    const r = rig();
    r.hub.setClientSecret("google", "SECRET-XYZ");
    await connect(r);
    r.advance(3600_000);
    r.hub["f"] = (async () => new Response(JSON.stringify({ error: "invalid_grant" }), { status: 400 })) as unknown as typeof fetch;
    await r.hub.accessToken("google");
    await r.hub.startService("google", { toPhone: true });
    const all = JSON.stringify([r.audit, r.sent]);
    for (const s of ["AT1", "RT1", "CODE", "SECRET-XYZ"]) expect(all).not.toContain(s);
  });

  it("an MCP connector's consent address is held until the owner opens its link, then handed over once", async () => {
    const r = rig();
    const { link } = await r.hub.approvalForMcp("gmail", new URL("https://as.example.com/authorize?x=1"), "Gmail");
    const t = link.split("/").pop()!;
    expect(r.hub.openTicket(t)).toBe("https://as.example.com/authorize?x=1");
    expect(r.hub.openTicket(t)).toBeNull();
  });

  it("an MCP return hands the code back without using it", async () => {
    const r = rig();
    const s = r.hub.tickets.issueState("mcp:gmail");
    expect(await r.hub.callback({ state: s, code: "C1" })).toEqual({ ok: true, key: "mcp:gmail", code: "C1" });
  });
});
