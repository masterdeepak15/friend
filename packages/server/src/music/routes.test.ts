import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { FakeProvider } from "../provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function boot(withFolder = true) {
  const dir = mkdtempSync(join(tmpdir(), "friend-musicapi-"));
  const music = mkdtempSync(join(tmpdir(), "friend-music-lib-"));
  mkdirSync(join(music, "Jazz"), { recursive: true });
  writeFileSync(join(music, "Jazz", "Miles Davis - So What.mp3"), Buffer.alloc(2000, 7));
  writeFileSync(join(music, "Jazz", "Miles Davis - Blue in Green.mp3"), Buffer.alloc(1500, 8));
  writeFileSync(join(music, "Jazz", "folder.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]));
  writeFileSync(join(music, "Daft Punk - Around the World.mp3"), Buffer.alloc(900, 9));
  writeFileSync(join(music, "notes.txt"), "not music");
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [] }, pluginCatalogDir: join(dir, "none") });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const j = { "content-type": "application/json" };
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...(init.body ? j : {}), cookie, ...((init.headers as Record<string, string>) ?? {}) } });
  const anon = (path: string) => fetch(base + path);
  if (withFolder) {
    const put = await api("/api/settings", { method: "PUT", body: JSON.stringify({ pin: owner.pin, settings: { music: { folder: music } } }) });
    expect(put.status).toBe(200);
  }
  const library = async (q = "") => (await (await api(`/api/music/library${q}`)).json()) as { tracks: { id: string; title: string; artist: string; cover: boolean }[]; total: number; folderSet: boolean };
  return { dir, music, api, anon, library };
}

describe("the library", () => {
  it("is for the signed-in owner only", async () => {
    const t = await boot();
    expect((await t.anon("/api/music/library")).status).toBe(401);
    expect((await t.anon("/api/music/track/0123456789abcdef")).status).toBe(401);
    expect((await t.anon("/api/music/cover/0123456789abcdef")).status).toBe(401);
  });

  it("lists the music in the folder chosen in the settings, with no paths, and can search and page", async () => {
    const t = await boot();
    const all = await t.library();
    expect(all).toMatchObject({ total: 3, folderSet: true });
    expect(JSON.stringify(all)).not.toContain(t.music);
    expect(all.tracks.map((x) => x.title).sort()).toEqual(["Around the World", "Blue in Green", "So What"]);
    expect((await t.library("?q=miles")).total).toBe(2);
    expect((await t.library("?limit=1")).tracks).toHaveLength(1);
    expect((await t.library("?offset=2&limit=5")).tracks).toHaveLength(1);
  });

  it("says no folder is set until the owner chooses one", async () => {
    const t = await boot(false);
    expect(await t.library()).toMatchObject({ total: 0, folderSet: false });
  });

  it("picks up new files after a rescan", async () => {
    const t = await boot();
    await t.library(); // the first scan is finished
    writeFileSync(join(t.music, "New Song.mp3"), Buffer.alloc(100));
    expect((await t.library()).total).toBe(3);
    const r = await t.api("/api/music/rescan", { method: "POST", body: "{}" });
    expect(r.status).toBe(200);
    expect(((await r.json()) as { count: number }).count).toBe(4);
    expect((await t.library()).total).toBe(4);
  });
});

describe("playing a track", () => {
  it("streams the whole file with its type and size, and accepts byte ranges so seeking works", async () => {
    const t = await boot();
    const id = (await t.library("?q=so%20what")).tracks[0]!.id;
    const full = await t.api(`/api/music/track/${id}`);
    expect(full.status).toBe(200);
    expect(full.headers.get("content-type")).toMatch(/audio\/mpeg/);
    expect(full.headers.get("accept-ranges")).toBe("bytes");
    expect(Number(full.headers.get("content-length"))).toBe(2000);
    expect((await full.arrayBuffer()).byteLength).toBe(2000);

    const part = await t.api(`/api/music/track/${id}`, { headers: { range: "bytes=100-199" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 100-199/2000");
    expect((await part.arrayBuffer()).byteLength).toBe(100);

    const tail = await t.api(`/api/music/track/${id}`, { headers: { range: "bytes=-50" } });
    expect(tail.status).toBe(206);
    expect((await tail.arrayBuffer()).byteLength).toBe(50);

    expect((await t.api(`/api/music/track/${id}`, { headers: { range: "bytes=5000-6000" } })).status).toBe(416);
  });

  it("will not open anything Friend did not list", async () => {
    const t = await boot();
    for (const id of ["0123456789abcdef", "../../etc/passwd", "..%2f..%2fsecret", "notahexid", "a".repeat(40)]) {
      expect((await t.api(`/api/music/track/${id}`)).status, id).toBe(404);
    }
  });

  it("serves a cover picture next to the track, and 404 when there is none", async () => {
    const t = await boot();
    const withCover = (await t.library("?q=so%20what")).tracks[0]!;
    const without = (await t.library("?q=around")).tracks[0]!;
    expect(withCover.cover).toBe(true);
    const c = await t.api(`/api/music/cover/${withCover.id}`);
    expect(c.status).toBe(200);
    expect(c.headers.get("content-type")).toMatch(/image\/jpeg/);
    expect((await c.arrayBuffer()).byteLength).toBe(8);
    expect((await t.api(`/api/music/cover/${without.id}`)).status).toBe(404);
  });
});
