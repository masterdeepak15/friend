import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { sanitizeMusic } from "../config";
import { FakeProvider } from "../provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

class FakeMpv {
  disposed = 0;
  resets = 0;
  onEvent() {
    return () => {};
  }
  async start() {
    return { ok: true as const };
  }
  async load() {}
  async pause() {}
  async seek() {}
  async volume() {}
  async mute() {}
  async stop() {}
  reset() {
    this.resets++;
  }
  dispose() {
    this.disposed++;
  }
}

async function boot(music: Record<string, unknown> = {}) {
  const dir = mkdtempSync(join(tmpdir(), "friend-hostapp-"));
  const mpv = new FakeMpv();
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [], music: sanitizeMusic({ output: "host", ...music }) }, pluginCatalogDir: join(dir, "none"), musicMpv: mpv as never });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const j = { "content-type": "application/json" };
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const save = (settings: unknown, pin: string | null = owner.pin) => fetch(`${base}/api/settings`, { method: "PUT", headers: { ...j, cookie }, body: JSON.stringify({ ...(pin ? { pin } : {}), settings }) });
  return { mpv, save, dir };
}

describe("the PC's player in the app", () => {
  it("is ended when Friend stops, so no mpv is left", async () => {
    const t = await boot();
    await app!.stop();
    app = undefined;
    expect(t.mpv.disposed).toBe(1);
  });

  it("is stopped when the output goes back to the screen, and not when something else changes", async () => {
    const t = await boot();
    const stop = vi.spyOn(app!.musicHost, "stop");
    expect((await t.save({ music: { volume: 40 } })).status).toBe(200);
    expect(stop).not.toHaveBeenCalled();
    expect((await t.save({ music: { output: "screen" } })).status).toBe(200);
    await vi.waitFor(() => expect(stop).toHaveBeenCalledTimes(1));
  });

  it("restarts mpv when the program setting changes, so the new one is used", async () => {
    const t = await boot();
    expect((await t.save({ music: { hostPlayer: "mpv" } })).status).toBe(200);
    await vi.waitFor(() => expect(t.mpv.resets).toBe(1));
    expect((await t.save({ music: { volume: 41 } })).status).toBe(200);
    expect(t.mpv.resets).toBe(1);
  });

  it("only the owner with the PIN can change where the sound comes out", async () => {
    const t = await boot();
    expect((await t.save({ music: { output: "screen" } }, null)).status).toBeGreaterThanOrEqual(400);
    expect((await t.save({ music: { hostPlayer: "mpv --x" } })).status).toBeGreaterThanOrEqual(400);
    expect(t.mpv.resets).toBe(0);
  });
});
