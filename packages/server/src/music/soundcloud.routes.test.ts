import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { sanitizeMusic } from "../config";
import { FakeProvider } from "../provider/fake";
import { fakeSoundCloud } from "./testing/fakeSoundCloud";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const CLIENT = "abc123DEF456ghi789jkl012MNO345pq";
const SECRET = "s3cr3t-value-xyz";
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function boot(soundcloud: { installed: boolean; enabled: boolean; clientId: string } = { installed: true, enabled: true, clientId: "" }) {
  const dir = mkdtempSync(join(tmpdir(), "friend-sc-routes-"));
  const fake = fakeSoundCloud();
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [], music: sanitizeMusic({ soundcloud }) }, pluginCatalogDir: join(dir, "none"), musicFetch: fake.fetch });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const j = { "content-type": "application/json" };
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...(init.body ? j : {}), cookie, ...((init.headers as Record<string, string>) ?? {}) } });
  const anon = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: "manual", ...init, headers: { ...(init.body ? j : {}), ...((init.headers as Record<string, string>) ?? {}) } });
  const creds = (body: object) => api("/api/music/soundcloud/credentials", { method: "POST", body: JSON.stringify(body) });
  const connect = async () => {
    const r = await api("/api/music/soundcloud/connect", { method: "POST", body: JSON.stringify({ pin: owner.pin }) });
    return { r, url: r.ok ? new URL(((await r.json()) as { url: string }).url) : null };
  };
  const signIn = async () => {
    expect((await creds({ clientId: CLIENT, clientSecret: SECRET, pin: owner.pin })).status).toBe(200);
    const { url } = await connect();
    const back = await anon(`/api/music/oauth/callback?code=${fake.issueCode()}&state=${url!.searchParams.get("state")!}`);
    expect(back.headers.get("location")).toBe("/?music=connected");
  };
  return { fake, api, anon, creds, connect, signIn, base, dir };
}

describe("SoundCloud routes", () => {
  it("are for the signed-in owner only", async () => {
    const t = await boot();
    for (const p of ["/api/music/soundcloud/connect", "/api/music/soundcloud/disconnect", "/api/music/soundcloud/credentials"]) {
      expect((await t.anon(p, { method: "POST", body: "{}" })).status).toBe(401);
    }
    expect((await t.anon("/api/music/stream/soundcloud:1001")).status).toBe(401);
  });

  it("need the PIN to save the credentials, and the client id has the right shape", async () => {
    const t = await boot();
    expect((await t.creds({ clientId: CLIENT, clientSecret: SECRET })).status).toBe(400);
    expect((await t.creds({ clientId: CLIENT, clientSecret: SECRET, pin: "000000" })).status).toBeGreaterThanOrEqual(400);
    const bad = await t.creds({ clientId: "not valid!", clientSecret: SECRET, pin: owner.pin });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { error: string }).error).toMatch(/client id/i);
    const off = await boot({ installed: false, enabled: false, clientId: "" });
    expect((await off.creds({ clientId: CLIENT, clientSecret: SECRET, pin: owner.pin })).status).toBe(400);
  });

  it("keep the secret write-only: no route, no file but its own, hands it back", async () => {
    const t = await boot();
    await t.creds({ clientId: CLIENT, clientSecret: SECRET, pin: owner.pin });
    const sources = await (await t.api("/api/music/sources")).text();
    expect(sources).not.toContain(SECRET);
    expect(JSON.parse(sources).soundcloud).toMatchObject({ clientId: CLIENT, secretSet: true, redirectUri: expect.stringMatching(/\/api\/music\/oauth\/callback$/) });
    const settings = await (await t.api("/api/settings")).text();
    expect(settings).not.toContain(SECRET);
    const integrations = await (await t.api("/api/plugins")).text();
    expect(integrations).not.toContain(SECRET);
    for (const f of readdirSync(t.dir)) {
      if (f === "music-soundcloud.secret.json") continue;
      if (/\.(json|db|log)$/.test(f)) expect(readFileSync(join(t.dir, f), "latin1")).not.toContain(SECRET);
    }
  });

  it("keeps the saved secret when only the client id is sent again", async () => {
    const t = await boot();
    await t.creds({ clientId: CLIENT, clientSecret: SECRET, pin: owner.pin });
    expect((await t.creds({ clientId: CLIENT, pin: owner.pin })).status).toBe(200);
    const sources = JSON.parse(await (await t.api("/api/music/sources")).text());
    expect(sources.soundcloud.secretSet).toBe(true);
  });

  it("go through the whole sign-in, search SoundCloud, and disconnect with the PIN", async () => {
    const t = await boot();
    const none = await t.connect();
    expect(none.r.status).toBe(400);
    await t.signIn();
    const sources = JSON.parse(await (await t.api("/api/music/sources")).text());
    expect(sources.sources.find((s: { id: string }) => s.id === "soundcloud").status).toMatchObject({ connected: true, account: "Owner Name" });
    const found = (await (await t.api("/api/music/search?q=midnight&source=soundcloud&limit=3")).json()) as { tracks: { ref: string }[] };
    expect(found.tracks.map((x) => x.ref)).toEqual(["soundcloud:1001"]);
    expect((await t.api("/api/music/soundcloud/disconnect", { method: "POST", body: "{}" })).status).toBe(400);
    expect((await t.api("/api/music/soundcloud/disconnect", { method: "POST", body: JSON.stringify({ pin: owner.pin }) })).status).toBe(200);
    const after = JSON.parse(await (await t.api("/api/music/sources")).text());
    expect(after.sources.find((s: { id: string }) => s.id === "soundcloud").status.connected).toBe(false);
  });

  it("a state is single use, and a made-up one fails", async () => {
    const t = await boot();
    await t.creds({ clientId: CLIENT, clientSecret: SECRET, pin: owner.pin });
    const { url } = await t.connect();
    const state = url!.searchParams.get("state")!;
    expect((await t.anon(`/api/music/oauth/callback?code=${t.fake.issueCode()}&state=${state}`)).headers.get("location")).toBe("/?music=connected");
    expect((await t.anon(`/api/music/oauth/callback?code=${t.fake.issueCode()}&state=${state}`)).headers.get("location")).toBe("/?music=failed");
    expect((await t.anon("/api/music/oauth/callback?code=x&state=made-up")).headers.get("location")).toBe("/?music=failed");
  });
});

describe("the stream route", () => {
  it("plays a track's audio through Friend, with seek (partial content) passing through", async () => {
    const t = await boot();
    await t.signIn();
    const whole = await t.api("/api/music/stream/soundcloud:1001");
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toMatch(/audio\/mpeg/);
    expect(whole.headers.get("cache-control")).toBe("no-store");
    expect(await whole.text()).toBe("AUDIOBYTES");
    const part = await t.api("/api/music/stream/soundcloud:1001", { headers: { range: "bytes=0-9" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 0-9/10");
  });

  it("says in a sentence when the source is not connected, the ref is odd, or the track cannot be played", async () => {
    const t = await boot();
    expect((await t.api("/api/music/stream/soundcloud:1001")).status).toBe(404);
    await t.signIn();
    expect((await t.api("/api/music/stream/soundcloud:abc")).status).toBe(404);
    expect((await t.api("/api/music/stream/spotify:4uLU6hMCjMI75M1A2tKUQC")).status).toBe(404);
    expect((await t.api("/api/music/stream/0123456789abcdef")).status).toBe(404);
    const blocked = await t.api("/api/music/stream/soundcloud:1003");
    expect(blocked.status).toBe(404);
    expect(((await blocked.json()) as { error: string }).error).toMatch(/does not let this account play/i);
  });

  it("never lets the audio come from, or be redirected to, a host that is not SoundCloud's", async () => {
    const t = await boot();
    await t.signIn();
    t.fake.redirectTo = "https://evil.example.com/steal.mp3?sig=TOPSECRET";
    const r = await t.api("/api/music/stream/soundcloud:1001");
    expect(r.status).toBe(502);
    const text = await r.text();
    expect(text).not.toMatch(/evil|TOPSECRET|SECRETSIG/);
    expect(t.fake.requests.some((q) => q.url.includes("evil.example.com"))).toBe(false);
  });
});
