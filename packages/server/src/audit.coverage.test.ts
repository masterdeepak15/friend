import { ClientMsg, TOOL_DEFS } from "@friend/protocol";
import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { Approvals } from "./approvals";
import { createApp } from "./app";
import { Audit } from "./audit";
import { Auth } from "./auth";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { PolicyEngine } from "./policy/engine";
import { FakeProvider } from "./provider/fake";
import { StageState } from "./stage";
import { Agent } from "./agent/loop";

/**
 * The trail must be complete by construction, not by every feature remembering to log. Each of these walks a list of everything
 * that can change something and fails when one leaves no entry. A skip must name the thing and say why.
 */
type Skip = { what: string; why: string };
const checkSkips = (skips: Skip[]) => skips.forEach((s) => expect(s.why.length, `skip of ${s.what} needs a reason`).toBeGreaterThan(10));

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App | undefined;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };
const sockets: WebSocket[] = [];
const until = async (cond: () => boolean, ms = 4000) => {
  for (let t = 0; t < ms && !cond(); t += 20) await new Promise((r) => setTimeout(r, 20));
};
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app?.stop();
  app = undefined;
});

describe("every tool leaves an entry", () => {
  it("the dispatcher records the start of every tool in the registry, however it was called", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-coverage-tools-"));
    const db = openDb(dir);
    const audit = new Audit(db);
    const auth = new Auth(db, audit);
    await auth.setupOwner(owner);
    const config = loadConfig(dir);
    const policy = new PolicyEngine(db, config);
    const approvals = new Approvals({ auth, policy, audit, db }, 200);
    const emit = (m: ServerMsg) => {
      if (m.type === "approval.request") void approvals.respond({ id: m.id, decision: "deny" }, "9.9.9.9");
    };
    const skips: Skip[] = [];
    checkSkips(skips);
    for (const def of TOOL_DEFS) {
      if (skips.some((s) => s.what === def.name)) continue;
      const provider = new FakeProvider([[{ type: "tool_call", id: "c1", name: def.name, args: {} }, { type: "done" }], [{ type: "text_delta", text: "ok" }, { type: "done" }]]);
      const agent = new Agent({ provider, policy, approvals, devices: { exec: vi.fn(async () => ({ ok: true as const, output: "x", truncated: false })), hasOnline: () => true, targetName: () => "pc" } as never, stage: new StageState(), db, audit, config, assistantName: () => "Jarvis" });
      await agent.runTurn(`use ${def.name}`, { trust: "owner", emit, ip: "9.9.9.9" });
    }
    const started = new Set(audit.list(5000).filter((r) => r.kind === "tool.start").map((r) => r.target));
    const missing = TOOL_DEFS.map((d) => d.name).filter((n) => !started.has(n) && !skips.some((s) => s.what === n));
    expect(missing).toEqual([]);
  }, 120_000);

  it("a tool the registry does not know (a plugin's, a connector's) is recorded too", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-coverage-unknown-"));
    const db = openDb(dir);
    const audit = new Audit(db);
    const auth = new Auth(db, audit);
    await auth.setupOwner(owner);
    const config = loadConfig(dir);
    const policy = new PolicyEngine(db, config);
    const approvals = new Approvals({ auth, policy, audit, db }, 200);
    const provider = new FakeProvider([[{ type: "tool_call", id: "c1", name: "plugin.mystery", args: {} }, { type: "done" }], [{ type: "text_delta", text: "ok" }, { type: "done" }]]);
    const agent = new Agent({ provider, policy, approvals, devices: { exec: vi.fn(), hasOnline: () => true, targetName: () => "pc" } as never, stage: new StageState(), db, audit, config, assistantName: () => "Jarvis" });
    await agent.runTurn("use it", { trust: "owner", emit: () => {}, ip: "9.9.9.9" });
    expect(audit.list(20).some((r) => r.kind === "tool.start" && r.target === "plugin.mystery")).toBe(true);
  });
});

describe("every route that changes something leaves an entry", () => {
  it("each POST, PUT, PATCH and DELETE route, called without signing in, is recorded as a refused outsider request", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-coverage-routes-"));
    app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [] }, pluginCatalogDir: join(dir, "none") });
    port = (await app.start()).port;
    await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
    const source = readFileSync(join(__dirname, "gateway.ts"), "utf8");
    const routes = [...source.matchAll(/\bapp\.(post|put|patch|delete)\b[^("]*\(\s*"(\/[^"]*)"/g)].map((m) => ({ method: m[1]!.toUpperCase(), route: m[2]! }));
    expect(routes.length).toBeGreaterThan(20);
    const skips: Skip[] = [];
    checkSkips(skips);
    const missing: string[] = [];
    for (const r of routes) {
      if (skips.some((s) => s.what === `${r.method} ${r.route}`)) continue;
      const url = base() + r.route.replace(/:[A-Za-z]+/g, "x");
      await fetch(url, { method: r.method, headers: j, ...(r.method === "DELETE" ? {} : { body: "{}" }) }).catch(() => {});
    }
    const rows = new Audit(app.db).list(5000).filter((x) => x.kind === "http.request");
    for (const r of routes) if (!skips.some((s) => s.what === `${r.method} ${r.route}`) && !rows.some((x) => x.target === `${r.method} ${r.route}`)) missing.push(`${r.method} ${r.route}`);
    expect(missing).toEqual([]);
    expect(rows.every((x) => x.actorKind === "outsider")).toBe(true);
  }, 120_000);
});

describe("every message from a screen leaves an entry", () => {
  /** A valid message for each type. A new type with no sample here fails the test: add one, or skip it with a reason. */
  const SAMPLES: Record<string, Record<string, unknown>> = {
    "chat.send": { text: "hello" },
    "stage.event": { objectId: "x", event: "click" },
    "approval.respond": { id: "00000000-0000-4000-8000-000000000000", decision: "deny" },
    "voice.interrupt": {},
    "voice.confirm": { id: "x", pin: "123456" },
    "voice.cancel": { id: "x" },
    "camera.denied": { id: "x", reason: "off" },
    "screen.checked": { id: "x", lines: [] },
    "screen.denied": { id: "x", reason: "failed" },
    "ui.panels": { open: ["chat"] },
    "ui.screen": { width: 800, height: 600, kind: "desktop", orientation: "landscape", touch: false },
    "stage.move": { objectId: "x", rect: { x: 0, y: 0, w: 0.5, h: 0.5 } },
    "stage.pin": { objectId: "x", pinned: true },
    "music.remote": { command: { action: "pause" } },
    "office.stop": {},
    "office.fire": { workerId: "nobody" },
    "office.say": { workerId: "nobody", text: "hi" },
  };
  const SKIPS: Skip[] = [
    { what: "ping", why: "a keep-alive heartbeat, sent every few seconds, that changes nothing" },
    { what: "audio.activity", why: "a level meter telling whether this screen is listening or speaking, many times a minute" },
    { what: "music.state", why: "the player's progress reported once a second, not something the owner did" },
  ];

  it("every client message type is either recorded or skipped with a reason", async () => {
    checkSkips(SKIPS);
    const types = (ClientMsg.options as unknown as { shape: { type: { value: string } } }[]).map((o) => o.shape.type.value);
    const unsampled = types.filter((t) => !(t in SAMPLES) && !SKIPS.some((s) => s.what === t));
    expect(unsampled, "a new message type needs a sample or a named skip").toEqual([]);

    const dir = mkdtempSync(join(tmpdir(), "friend-coverage-ws-"));
    app = await createApp({ dataDir: dir, provider: new FakeProvider([[{ type: "text_delta", text: "hi" }, { type: "done" }]]), config: { port: 0, roots: [] }, pluginCatalogDir: join(dir, "none") });
    port = (await app.start()).port;
    await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
    const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base() } });
    sockets.push(ws);
    await new Promise<void>((r, e) => (ws.on("open", () => r()), ws.on("error", e)));
    const sent = types.filter((t) => t in SAMPLES);
    for (const t of sent) ws.send(JSON.stringify({ type: t, ...SAMPLES[t] }));
    await until(() => new Audit(app!.db).list(500).filter((r) => r.kind === "ws.message").length >= sent.length);
    const got = new Set(new Audit(app!.db).list(500).filter((r) => r.kind === "ws.message").map((r) => r.target));
    expect(sent.filter((t) => !got.has(t))).toEqual([]);
  }, 60_000);
});
