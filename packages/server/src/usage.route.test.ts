import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "./app";
import { FakeProvider } from "./provider/fake";
import type { ProviderEvent } from "./provider/types";
import type { UsageSummary } from "./usage";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };
const sockets: WebSocket[] = [];

async function boot(script: ProviderEvent[][]) {
  const dir = mkdtempSync(join(tmpdir(), "friend-usage-route-"));
  app = await createApp({ dataDir: dir, provider: new FakeProvider(script), config: { port: 0, roots: [] }, pluginCatalogDir: join(dir, "none") });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const summary = async (cookie: string, q = "") => (await (await fetch(base() + "/api/usage" + q, { headers: { cookie } })).json()) as UsageSummary;
const until = async (cond: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !cond(); t += 20) await new Promise((r) => setTimeout(r, 20));
};

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await app?.stop();
});

describe("token usage", () => {
  it("is only for the signed-in owner", async () => {
    await boot([]);
    expect((await fetch(base() + "/api/usage")).status).toBe(401);
    expect((await fetch(base() + "/api/usage", { method: "DELETE" })).status).toBe(401);
  });

  it("starts empty, with a row for every day asked for", async () => {
    const cookie = await boot([]);
    const s = await summary(cookie, "?days=7");
    expect(s.range).toBe(7);
    expect(s.days).toHaveLength(7);
    expect(s.total).toEqual({ input: 0, output: 0, turns: 0 });
  });

  it("counts a chat turn by the tokens the model reported, and says it came from chat", async () => {
    const cookie = await boot([[{ type: "usage", input: 120, output: 30 }, { type: "text_delta", text: "Hello." }, { type: "done" }]]);
    const msgs: ServerMsg[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base() } });
    sockets.push(ws);
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "chat.send", text: "hi" }));
    await until(() => msgs.some((m) => m.type === "caption.delta"));
    let s = await summary(cookie);
    for (let i = 0; i < 100 && s.total.turns === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      s = await summary(cookie);
    }
    expect(s.total).toEqual({ input: 120, output: 30, turns: 1 });
    expect(s.bySource).toEqual([{ source: "chat", input: 120, output: 30, turns: 1 }]);
    expect(s.byModel).toHaveLength(1);
  });

  it("can be cleared", async () => {
    const cookie = await boot([[{ type: "usage", input: 5, output: 5 }, { type: "text_delta", text: "ok" }, { type: "done" }]]);
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base() } });
    sockets.push(ws);
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "chat.send", text: "hi" }));
    let s = await summary(cookie);
    for (let i = 0; i < 100 && s.total.turns === 0; i++) {
      await new Promise((r) => setTimeout(r, 20));
      s = await summary(cookie);
    }
    expect(s.total.turns).toBe(1);
    const res = await fetch(base() + "/api/usage", { method: "DELETE", headers: { cookie } });
    expect(await res.json()).toEqual({ removed: 1 });
    expect((await summary(cookie)).total.turns).toBe(0);
  });
});
