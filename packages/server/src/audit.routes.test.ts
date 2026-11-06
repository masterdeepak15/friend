import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "./app";
import { Audit } from "./audit";
import { FakeProvider } from "./provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App | undefined;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };
const sockets: WebSocket[] = [];

async function boot(script: ConstructorParameters<typeof FakeProvider>[0] = []) {
  const dir = mkdtempSync(join(tmpdir(), "friend-audit-routes-"));
  app = await createApp({ dataDir: dir, provider: new FakeProvider(script), config: { port: 0, roots: [] }, pluginCatalogDir: join(dir, "none") });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const rows = (kind: string) => new Audit(app!.db).list(200).filter((r) => r.kind === kind).reverse();
const until = async (cond: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !cond(); t += 20) await new Promise((r) => setTimeout(r, 20));
};
async function connect(cookie: string) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base() } });
  sockets.push(ws);
  await new Promise<void>((r, e) => (ws.on("open", () => r()), ws.on("error", e)));
  return ws;
}

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  await app?.stop();
  app = undefined;
});

describe("every request that changes something is recorded", () => {
  it("a failed login is an outsider's refused request, with the address", async () => {
    await boot();
    const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: "wrong password here" }) });
    expect(res.status).toBeGreaterThanOrEqual(400);
    const failed = rows("http.request").filter((r) => r.target === "POST /api/login");
    const last = failed.at(-1)!;
    expect(last).toMatchObject({ actorKind: "outsider", outcome: "refused", detail: { status: res.status } });
    expect(String(last.detail.ip)).toMatch(/127\.0\.0\.1|::1/);
    expect(JSON.stringify(last.detail)).not.toMatch(/wrong password here/);
  });

  it("a request from the signed-in owner is the owner's", async () => {
    const cookie = await boot();
    const res = await fetch(base() + "/api/usage", { method: "DELETE", headers: { cookie } });
    expect(res.status).toBe(200);
    const mine = rows("http.request").filter((r) => r.target === "DELETE /api/usage");
    expect(mine).toHaveLength(1);
    expect(mine[0]).toMatchObject({ actorKind: "owner", outcome: "done", detail: { status: 200 } });
  });

  it("a plain read writes nothing", async () => {
    const cookie = await boot();
    const before = rows("http.request").length;
    await fetch(base() + "/api/state", { headers: { cookie } });
    await fetch(base() + "/api/session", { headers: { cookie } });
    expect(rows("http.request").length).toBe(before);
  });

  it("a request for a route that does not exist is recorded, and a flood of them is counted instead of filling the log", async () => {
    await boot();
    for (let i = 0; i < 60; i++) await fetch(base() + `/api/nothing-${i}`, { method: "POST", headers: j, body: "{}" });
    await until(() => rows("http.request").length >= 20);
    const misses = rows("http.request").filter((r) => /nothing/.test(r.target));
    expect(misses.length).toBeGreaterThan(0);
    expect(misses.length).toBeLessThanOrEqual(31);
    expect(misses[0]).toMatchObject({ actorKind: "outsider", outcome: "refused", detail: { status: 404 } });
    expect(rows("http.flood").length).toBeGreaterThanOrEqual(1);
  });
});

describe("every message from the screen is recorded", () => {
  it("records the type and what it says, and never a PIN", async () => {
    const cookie = await boot([[{ type: "text_delta", text: "Hello." }, { type: "done" }]]);
    const ws = await connect(cookie);
    ws.send(JSON.stringify({ type: "chat.send", text: "good morning" }));
    ws.send(JSON.stringify({ type: "approval.respond", id: "00000000-0000-4000-8000-000000000000", decision: "approve", pin: "123456" }));
    ws.send(JSON.stringify({ type: "office.stop", workerId: "nobody" }));
    await until(() => rows("ws.message").length >= 3);
    const msgs = rows("ws.message");
    expect(msgs.map((m) => m.target)).toEqual(["chat.send", "approval.respond", "office.stop"]);
    expect(msgs.every((m) => m.actorKind === "owner")).toBe(true);
    expect(msgs[0]!.detail).toMatchObject({ type: "chat.send", text: "good morning" });
    expect(JSON.stringify(msgs[1]!.detail)).not.toContain("123456");
    expect(msgs[0]!.requestId).toMatch(/^chat-/);
  });
});
