import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { sanitizeMusic } from "../config";
import { FakeProvider } from "../provider/fake";
import { fakeAudius } from "./testing/fakeAudius";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function boot(audius: { installed: boolean; enabled: boolean } = { installed: true, enabled: true }) {
  const dir = mkdtempSync(join(tmpdir(), "friend-audius-routes-"));
  const fake = fakeAudius();
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [], music: sanitizeMusic({ audius }) }, pluginCatalogDir: join(dir, "none"), musicFetch: fake.fetch, musicResolve: async () => ["93.184.216.34"] });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const j = { "content-type": "application/json" };
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...(init.body ? j : {}), cookie, ...((init.headers as Record<string, string>) ?? {}) } });
  const anon = (path: string) => fetch(base + path, { redirect: "manual" });
  return { fake, api, anon };
}

describe("Audius routes", () => {
  it("are for the signed-in owner only", async () => {
    const t = await boot();
    expect((await t.anon("/api/music/stream/audius:95wro")).status).toBe(401);
  });

  it("list Audius as a connected source, and search it", async () => {
    const t = await boot();
    const sources = (await (await t.api("/api/music/sources")).json()) as { sources: { id: string; status: { connected: boolean } }[] };
    expect(sources.sources.find((s) => s.id === "audius")!.status.connected).toBe(true);
    const found = (await (await t.api("/api/music/search?q=stars&source=audius&limit=3")).json()) as { tracks: { ref: string }[] };
    expect(found.tracks.map((x) => x.ref)).toEqual(["audius:95wro"]);
  });

  it("is off until it is installed and switched on", async () => {
    const t = await boot({ installed: true, enabled: false });
    const r = await t.api("/api/music/stream/audius:95wro");
    expect(r.status).toBe(404);
    expect(((await r.json()) as { error: string }).error).toMatch(/install and switch on audius/i);
  });

  it("streams a track through Friend, with seek passing through", async () => {
    const t = await boot();
    const whole = await t.api("/api/music/stream/audius:95wro");
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toMatch(/audio\/mpeg/);
    expect(whole.headers.get("cache-control")).toBe("no-store");
    expect(await whole.text()).toBe("AUDIOBYTES");
    const part = await t.api("/api/music/stream/audius:95wro", { headers: { range: "bytes=0-9" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 0-9/10");
  });

  it("says in a sentence when a track cannot be played or the ref is odd", async () => {
    const t = await boot();
    expect((await t.api("/api/music/stream/audius:gated1")).status).toBe(404);
    expect((await t.api("/api/music/stream/audius:a%20b")).status).toBe(404);
    expect((await t.api("/api/music/stream/spotify:4uLU6hMCjMI75M1A2tKUQC")).status).toBe(404);
  });

  it("never fetches from a private or odd place Audius redirects to, and says nothing of the address", async () => {
    const t = await boot();
    t.fake.node = "https://127.0.0.1/tracks/cidstream/Qm1?signature=TOPSECRET";
    const r = await t.api("/api/music/stream/audius:95wro");
    expect(r.status).toBeGreaterThanOrEqual(400);
    expect(await r.text()).not.toMatch(/127\.0|TOPSECRET/);
    expect(t.fake.requests.some((q) => q.url.includes("127.0.0.1"))).toBe(false);
  });
});
