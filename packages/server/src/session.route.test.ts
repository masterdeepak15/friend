import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "./app";
import { FakeProvider } from "./provider/fake";
import type { ProviderEvent } from "./provider/types";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };
const sockets: WebSocket[] = [];

/** A model that keeps a conversation of its own, and notes when it was reset. */
class Keeping extends FakeProvider {
  resets: (string | undefined)[] = [];
  async resetSession(seed?: string): Promise<void> {
    this.resets.push(seed);
  }
}

async function boot(provider: FakeProvider) {
  const dir = mkdtempSync(join(tmpdir(), "friend-session-"));
  app = await createApp({ dataDir: dir, provider, config: { port: 0, roots: [] }, pluginCatalogDir: join(dir, "none") });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const get = (cookie: string) => fetch(base() + "/api/conversation", { headers: { cookie } });
const post = (cookie: string, path: string, body: unknown = {}) => fetch(base() + "/api/conversation" + path, { method: "POST", headers: { ...j, cookie }, body: JSON.stringify(body) });
const turn = (context: number): ProviderEvent[] => [{ type: "usage", input: 1, output: 1, context }, { type: "text_delta", text: "Sure." }, { type: "done" }];

async function chat(cookie: string, text: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base() } });
  sockets.push(ws);
  const seen: string[] = [];
  ws.on("message", (d) => seen.push(JSON.parse(String(d)).type));
  await new Promise((r) => ws.on("open", r));
  ws.send(JSON.stringify({ type: "chat.send", text }));
  for (let i = 0; i < 150 && !seen.includes("caption.end"); i++) await new Promise((r) => setTimeout(r, 20));
  for (let i = 0; i < 50; i++) {
    await new Promise((r) => setTimeout(r, 20));
    if (seen.at(-1) === "status") break;
  }
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await app?.stop();
});

describe("the model's own conversation", () => {
  it("is only for the signed-in owner", async () => {
    await boot(new Keeping([]));
    expect((await fetch(base() + "/api/conversation")).status).toBe(401);
    expect((await fetch(base() + "/api/conversation/compact", { method: "POST" })).status).toBe(401);
    expect((await fetch(base() + "/api/conversation/clear", { method: "POST" })).status).toBe(401);
  });

  it("says how big it is and whether tidying up is on", async () => {
    const cookie = await boot(new Keeping([turn(150_000)]));
    expect(await (await get(cookie)).json()).toEqual({ supported: true, contextTokens: 0, autoCompact: true, compactAtTokens: 100_000 });
    await chat(cookie, "hello");
    expect(await (await get(cookie)).json()).toMatchObject({ contextTokens: 150_000 });
  });

  it("says when this model keeps no conversation of its own", async () => {
    const cookie = await boot(new FakeProvider([]));
    expect(await (await get(cookie)).json()).toMatchObject({ supported: false });
    const r = await post(cookie, "/compact");
    expect(await r.json()).toMatchObject({ ok: false, message: expect.stringMatching(/does not keep/i) });
  });

  it("compacts on request: notes are written, the conversation starts over from them", async () => {
    const p = new Keeping([turn(150_000), [{ type: "text_delta", text: "Planning a trip." }, { type: "done" }]]);
    const cookie = await boot(p);
    await chat(cookie, "let's plan a trip");
    const r = await post(cookie, "/compact");
    expect(await r.json()).toMatchObject({ ok: true });
    expect(p.resets).toEqual(["Planning a trip."]);
    expect(await (await get(cookie)).json()).toMatchObject({ contextTokens: 0 });
  });

  it("starts fresh only with the PIN", async () => {
    const p = new Keeping([]);
    const cookie = await boot(p);
    expect((await post(cookie, "/clear", {})).status).toBe(400);
    expect((await post(cookie, "/clear", { pin: "000000" })).status).toBe(403);
    expect(p.resets).toEqual([]);
    const r = await post(cookie, "/clear", { pin: owner.pin });
    expect(await r.json()).toMatchObject({ ok: true });
    expect(p.resets).toEqual([undefined]);
  });
});
