import type { ServerMsg } from "@friend/protocol";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "../app";
import { FakeProvider } from "../provider/fake";
import type { BridgeLike, WorkerLike } from "./office";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App | undefined;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };
const sockets: WebSocket[] = [];
const procs: FakeProc[] = [];

class FakeProc implements WorkerLike {
  alive = true;
  killed = 0;
  sent: string[] = [];
  exited: Promise<void>;
  private done!: () => void;
  constructor() {
    this.exited = new Promise((r) => (this.done = r));
  }
  send(t: string) {
    this.sent.push(t);
  }
  kill() {
    this.killed++;
    this.alive = false;
    this.done();
  }
}
const bridge = (): BridgeLike => ({ url: "http://127.0.0.1:1/mcp", token: "t", start: async () => {}, stop: async () => {}, setTools() {}, failPending() {} });

async function boot(officeOn = true) {
  const dir = mkdtempSync(join(tmpdir(), "friend-officewire-"));
  const folder = join(dir, "site");
  mkdirSync(folder);
  app = await createApp({
    dataDir: dir,
    provider: new FakeProvider([]),
    config: {
      port: 0,
      roots: [],
      office: { enabled: officeOn, maxConcurrent: 2, startTimeoutSec: 60, pauseAtWindow: 0.9, budget: { perWorkerTokens: 0, totalTokens: 0 }, roles: [{ id: "scribe", title: "Scribe", instructions: "Write.", model: "", permission: "default" }], projects: [{ id: "site", name: "Site", folder, goal: "", extraFolders: [] }], policy: { allowTools: ["Read"], denyCommands: [] } },
    },
    pluginCatalogDir: join(dir, "none"),
    office: {
      spawn: () => {
        const p = new FakeProc();
        procs.push(p);
        return p;
      },
      bridge,
    },
  });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
async function connect(cookie: string) {
  const got: ServerMsg[] = [];
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base() } });
  sockets.push(ws);
  ws.on("message", (d) => got.push(JSON.parse(String(d)) as ServerMsg));
  await new Promise<void>((r, e) => (ws.on("open", () => r()), ws.on("error", e)));
  return { ws, got };
}
const until = async (cond: () => boolean, ms = 3000) => {
  for (let t = 0; t < ms && !cond(); t += 20) await new Promise((r) => setTimeout(r, 20));
};

afterEach(async () => {
  for (const s of sockets.splice(0)) s.close();
  procs.length = 0;
  await app?.stop();
  app = undefined;
});

describe("the Office in the app", () => {
  it("sends the Office state to a screen that connects", async () => {
    const cookie = await boot();
    const { got } = await connect(cookie);
    await until(() => got.some((m) => m.type === "office.state"));
    expect(got.find((m) => m.type === "office.state")).toMatchObject({ type: "office.state", enabled: true, workers: [], tickets: [] });
  });

  it("says the Office is off when it is off", async () => {
    const cookie = await boot(false);
    const { got } = await connect(cookie);
    await until(() => got.some((m) => m.type === "office.state"));
    expect(got.find((m) => m.type === "office.state")).toMatchObject({ enabled: false });
  });

  it("forwards office.say from the screen to the worker, and office.stop stops it", async () => {
    const cookie = await boot();
    const { ws, got } = await connect(cookie);
    const hired = app!.office.hire({ role: "scribe", project: "site", name: "Ada" });
    if (!hired.ok) throw new Error(hired.error);
    app!.office.assign({ worker: "Ada", title: "Write notes" });
    await until(() => procs.length === 1);
    ws.send(JSON.stringify({ type: "office.say", workerId: hired.worker.id, text: "use tabs" }));
    await until(() => procs[0]!.sent.includes("use tabs"));
    expect(procs[0]!.sent.at(-1)).toBe("use tabs");
    ws.send(JSON.stringify({ type: "office.stop", workerId: hired.worker.id }));
    await until(() => procs[0]!.killed > 0);
    expect(procs[0]!.killed).toBeGreaterThan(0);
    await until(() => got.some((m) => m.type === "office.state" && m.workers.some((w) => w.status === "stopped")));
    expect(got.some((m) => m.type === "office.state" && m.workers.some((w) => w.status === "stopped"))).toBe(true);
  });

  it("stops every worker when the app closes", async () => {
    await boot();
    app!.office.hire({ role: "scribe", project: "site", name: "Ada" });
    app!.office.assign({ worker: "Ada", title: "Write notes" });
    await until(() => procs.length === 1);
    const shutdown = vi.spyOn(app!.office, "shutdown");
    await app!.stop();
    expect(shutdown).toHaveBeenCalled();
    expect(procs[0]!.killed).toBeGreaterThan(0);
    app = undefined;
  });

  it("stops the workers and tells the screens when the owner switches the Office off", async () => {
    const cookie = await boot();
    const { got } = await connect(cookie);
    app!.office.hire({ role: "scribe", project: "site", name: "Ada" });
    app!.office.assign({ worker: "Ada", title: "Write notes" });
    await until(() => procs.length === 1);
    const res = await fetch(base() + "/api/settings", { method: "PUT", headers: { ...j, cookie }, body: JSON.stringify({ pin: owner.pin, settings: { office: { enabled: false } } }) });
    expect(res.status).toBeLessThan(300);
    await until(() => procs[0]!.killed > 0);
    expect(procs[0]!.killed).toBeGreaterThan(0);
    await until(() => got.some((m) => m.type === "office.state" && !m.enabled));
    expect(got.some((m) => m.type === "office.state" && !m.enabled)).toBe(true);
  });
});
