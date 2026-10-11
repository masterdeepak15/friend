import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../app";
import { sanitizeMusic } from "../config";
import { FakeProvider } from "../provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
let app: Awaited<ReturnType<typeof createApp>> | undefined;
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await app?.stop();
  app = undefined;
});

const fakeMpv = { onEvent: () => () => {}, start: async () => ({ ok: true as const }), load: async () => {}, pause: async () => {}, seek: async () => {}, volume: async () => {}, mute: async () => {}, stop: async () => {}, reset: () => {}, dispose: () => {} };

async function boot(output: "screen" | "host") {
  const dir = mkdtempSync(join(tmpdir(), "friend-hostws-"));
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [], music: sanitizeMusic({ output }) }, pluginCatalogDir: join(dir, "none"), musicMpv: fakeMpv as never });
  const { port } = await app.start();
  const j = { "content-type": "application/json" };
  await fetch(`http://127.0.0.1:${port}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
  const login = await fetch(`http://127.0.0.1:${port}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const got: ServerMsg[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
  sockets.push(ws);
  ws.on("message", (d) => got.push(JSON.parse(String(d))));
  await new Promise<void>((r) => ws.once("open", () => r()));
  const send = (m: unknown) => ws.send(JSON.stringify(m));
  return { got, send };
}
const find = <T extends ServerMsg["type"]>(got: ServerMsg[], type: T) => got.filter((m) => m.type === type) as Extract<ServerMsg, { type: T }>[];

describe("the PC's player and the screens", () => {
  it("a screen that connects is told which output is chosen and what the PC is playing", async () => {
    const t = await boot("host");
    await vi.waitFor(() => expect(find(t.got, "ui")).toHaveLength(1));
    expect(find(t.got, "ui")[0]!.music).toMatchObject({ output: "host" });
    await vi.waitFor(() => expect(find(t.got, "music.host")).toHaveLength(1));
    expect(find(t.got, "music.host")[0]!.state).toMatchObject({ playing: false, queue: [], index: -1 });
  });

  it("the ui message says the output is the screen when it is", async () => {
    const t = await boot("screen");
    await vi.waitFor(() => expect(find(t.got, "ui")).toHaveLength(1));
    expect(find(t.got, "ui")[0]!.music).toMatchObject({ output: "screen" });
  });

  it("a button pressed on a screen reaches the PC's player when the output is the PC", async () => {
    const t = await boot("host");
    const command = vi.spyOn(app!.musicHost, "command");
    await vi.waitFor(() => expect(find(t.got, "ui")).toHaveLength(1));
    t.send({ type: "music.remote", command: { action: "volume", level: 33 } });
    await vi.waitFor(() => expect(command).toHaveBeenCalledWith({ action: "volume", level: 33 }));
    await vi.waitFor(() => expect(find(t.got, "music.host").at(-1)!.state.volume).toBe(33));
  });

  it("is ignored when the output is the screen", async () => {
    const t = await boot("screen");
    const command = vi.spyOn(app!.musicHost, "command");
    await vi.waitFor(() => expect(find(t.got, "ui")).toHaveLength(1));
    t.send({ type: "music.remote", command: { action: "volume", level: 33 } });
    await new Promise((r) => setTimeout(r, 150));
    expect(command).not.toHaveBeenCalled();
  });

  it("a command the PC cannot do comes back to that screen as a warning in plain words", async () => {
    const t = await boot("host");
    await vi.waitFor(() => expect(find(t.got, "ui")).toHaveLength(1));
    t.send({ type: "music.remote", command: { action: "play", tracks: [{ id: "spotify:4uLU6hMCjMI75M1A2tKUQC", title: "x", artist: "", album: "", durationSec: null }], mode: "replace" } });
    await vi.waitFor(() => expect(find(t.got, "alert").some((a) => /Name the Spotify device/.test(a.text))).toBe(true));
  });
});
