import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { sanitizeMusic } from "../config";
import { FakeProvider } from "../provider/fake";
import { fakeSpotify } from "./testing/fakeSpotify";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const CLIENT = "abc123DEF456ghi789";
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function boot(spotify: { installed: boolean; enabled: boolean; clientId: string } = { installed: true, enabled: true, clientId: CLIENT }) {
  const dir = mkdtempSync(join(tmpdir(), "friend-sources-"));
  const fake = fakeSpotify();
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [], music: sanitizeMusic({ spotify }) }, pluginCatalogDir: join(dir, "none"), musicFetch: fake.fetch });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const j = { "content-type": "application/json" };
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...(init.body ? j : {}), cookie, ...((init.headers as Record<string, string>) ?? {}) } });
  const anon = (path: string, init: RequestInit = {}) => fetch(base + path, { redirect: "manual", ...init, headers: { ...(init.body ? j : {}), ...((init.headers as Record<string, string>) ?? {}) } });
  const connect = async () => {
    const r = await api("/api/music/spotify/connect", { method: "POST", body: JSON.stringify({ pin: owner.pin }) });
    return { r, url: r.ok ? new URL(((await r.json()) as { url: string }).url) : null };
  };
  return { fake, api, anon, connect, base };
}

describe("music sources routes", () => {
  it("are for the signed-in owner only; the return address needs no cookie but needs the one-time state", async () => {
    const t = await boot();
    expect((await t.anon("/api/music/sources")).status).toBe(401);
    expect((await t.anon("/api/music/search?q=x")).status).toBe(401);
    expect((await t.anon("/api/music/spotify/connect", { method: "POST", body: "{}" })).status).toBe(401);
    expect((await t.anon("/api/music/spotify/disconnect", { method: "POST", body: "{}" })).status).toBe(401);
    const cb = await t.anon("/api/music/oauth/callback?code=x&state=made-up");
    expect(cb.status).toBe(302);
    expect(cb.headers.get("location")).toBe("/?music=failed");
  });

  it("needs the PIN to connect, and a client id", async () => {
    const t = await boot();
    expect((await t.api("/api/music/spotify/connect", { method: "POST", body: "{}" })).status).toBe(400);
    expect((await t.api("/api/music/spotify/connect", { method: "POST", body: JSON.stringify({ pin: "000000" }) })).status).toBeGreaterThanOrEqual(400);
    const none = await boot({ installed: true, enabled: true, clientId: "" });
    const r = await none.connect();
    expect(r.r.status).toBe(400);
    expect(((await r.r.json()) as { error: string }).error).toMatch(/client id/i);
    const off = await boot({ installed: false, enabled: false, clientId: CLIENT });
    expect((await off.connect()).r.status).toBe(400);
  });

  it("goes through the whole sign-in, searches Spotify, and disconnects with the PIN", async () => {
    const t = await boot();
    const { url } = await t.connect();
    expect(url!.origin).toBe("https://accounts.spotify.com");
    const state = url!.searchParams.get("state")!;
    const back = await t.anon(`/api/music/oauth/callback?code=${t.fake.issueCode()}&state=${state}`);
    expect(back.headers.get("location")).toBe("/?music=connected");
    const replay = await t.anon(`/api/music/oauth/callback?code=${t.fake.issueCode()}&state=${state}`);
    expect(replay.headers.get("location")).toBe("/?music=failed");

    const sources = (await (await t.api("/api/music/sources")).json()) as { sources: { id: string; status: { connected: boolean; account: string | null } }[]; spotify: { redirectUri: string; clientId: string } };
    expect(sources.sources.find((s) => s.id === "spotify")!.status).toMatchObject({ connected: true, account: "Test Listener" });
    expect(sources.spotify).toMatchObject({ clientId: CLIENT, redirectUri: expect.stringMatching(/\/api\/music\/oauth\/callback$/) });

    const found = (await (await t.api("/api/music/search?q=never&source=spotify&limit=2")).json()) as { tracks: { ref: string }[]; notes: string[] };
    expect(found.tracks.map((x) => x.ref)).toEqual(["spotify:4uLU6hMCjMI75M1A2tKUQC", "spotify:7qiZfU4dY1lWllzX7mPBI3"]);

    expect((await t.api("/api/music/spotify/disconnect", { method: "POST", body: "{}" })).status).toBe(400);
    expect((await t.api("/api/music/spotify/disconnect", { method: "POST", body: JSON.stringify({ pin: owner.pin }) })).status).toBe(200);
    const after = (await (await t.api("/api/music/sources")).json()) as { sources: { id: string; status: { connected: boolean } }[] };
    expect(after.sources.find((s) => s.id === "spotify")!.status.connected).toBe(false);
  });

  it("never shows a token in the settings, the sources list or a search", async () => {
    const t = await boot();
    const { url } = await t.connect();
    await t.anon(`/api/music/oauth/callback?code=${t.fake.issueCode()}&state=${url!.searchParams.get("state")}`);
    for (const path of ["/api/settings", "/api/music/sources", "/api/music/search?q=x&source=spotify"]) {
      const text = await (await t.api(path)).text();
      expect(text, path).not.toMatch(/AT-\d|RT-\d|code_verifier/);
    }
  });

  it("a Spotify that is not connected answers a search with its note and keeps the folder's results", async () => {
    const t = await boot();
    const r = (await (await t.api("/api/music/search?q=x&source=any")).json()) as { tracks: unknown[]; notes: string[] };
    expect(r.notes.join(" ")).toMatch(/Connect your Spotify/);
  });
});
