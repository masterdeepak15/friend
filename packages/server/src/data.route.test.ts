import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";
import { createApp } from "./app";
import { chatLines } from "./chatlog";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { saveMessage } from "./agent/history";
import { FakeProvider } from "./provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir = "";
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };

async function boot(config: object = {}) {
  dir = mkdtempSync(join(tmpdir(), "friend-data-"));
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [], ...config } });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
afterEach(async () => {
  await app?.stop();
});

describe("the conversation and schedule data", () => {
  it("need a signed-in owner", async () => {
    await boot();
    expect((await fetch(base() + "/api/history")).status).toBe(401);
    expect((await fetch(base() + "/api/tasks")).status).toBe(401);
  });

  it("history gives the said and answered text only, answers written in steps as one", async () => {
    const cookie = await boot();
    const say = (role: "user" | "assistant", text: string) => saveMessage(app.db, { role, content: [{ type: "text", text }] });
    say("user", "weather in Pune?");
    saveMessage(app.db, { role: "assistant", content: [{ type: "text", text: "Let me look." }, { type: "tool_use", id: "t1", name: "weather.get", input: { city: "Pune" } }] });
    saveMessage(app.db, { role: "tool", content: [{ type: "tool_result", toolUseId: "t1", content: "Pune 31C secret-tool-output", isError: false }] });
    say("assistant", "It is 31 degrees.");
    say("user", "thanks");
    const lines = (await (await fetch(base() + "/api/history", { headers: { cookie } })).json()) as { role: string; text: string }[];
    expect(lines).toEqual([
      { role: "user", text: "weather in Pune?" },
      { role: "assistant", text: "Let me look.\n\nIt is 31 degrees." },
      { role: "user", text: "thanks" },
    ]);
    expect(JSON.stringify(lines)).not.toContain("secret-tool-output");
  });

  it("chatLines keeps only the newest lines", () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "friend-chatlog-")));
    for (let i = 0; i < 10; i++) saveMessage(db, { role: i % 2 ? "assistant" : "user", content: [{ type: "text", text: `m${i}` }] });
    expect(chatLines(db, 3).map((l) => l.text)).toEqual(["m7", "m8", "m9"]);
  });

  it("tasks gives the open tasks, soonest first", async () => {
    const cookie = await boot();
    app.tasks.add({ title: "later", dueAt: Date.now() + 3_600_000 });
    app.tasks.add({ title: "sooner", dueAt: Date.now() + 60_000 });
    app.tasks.add({ title: "someday" });
    const rows = (await (await fetch(base() + "/api/tasks", { headers: { cookie } })).json()) as { title: string; dueAt: number | null }[];
    expect(rows.map((r) => r.title)).toEqual(["sooner", "later", "someday"]);
  });
});

describe("the view", () => {
  it("defaults to companion and is sent to a screen when it connects", async () => {
    const cookie = await boot();
    const first = await new Promise<unknown[]>((resolve) => {
      const got: unknown[] = [];
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
      ws.on("message", (d) => {
        got.push(JSON.parse(String(d)));
        if (got.some((m) => (m as { type: string }).type === "ui")) {
          ws.close();
          resolve(got);
        }
      });
    });
    expect(first.find((m) => (m as { type: string }).type === "ui")).toEqual({ type: "ui", view: "companion" });
  });

  it("is kept in the config, and a bad value falls back to companion", async () => {
    await boot();
    expect(loadConfig(dir).view).toBe("companion");
    const { writeFileSync } = await import("node:fs");
    const stored = JSON.parse((await import("node:fs")).readFileSync(join(dir, "config.json"), "utf8"));
    writeFileSync(join(dir, "config.json"), JSON.stringify({ ...stored, view: "huge" }));
    expect(loadConfig(dir).view).toBe("companion");
    writeFileSync(join(dir, "config.json"), JSON.stringify({ ...stored, view: "workspace" }));
    expect(loadConfig(dir).view).toBe("workspace");
  });

  it("can be changed without the PIN, is saved, and is told to every open screen; other settings still need the PIN", async () => {
    const cookie = await boot();
    const got: unknown[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
    ws.on("message", (d) => got.push(JSON.parse(String(d))));
    await new Promise((r) => ws.on("open", r));
    await new Promise((r) => setTimeout(r, 100));
    got.length = 0;
    const put = (settings: unknown, pin?: string) => fetch(base() + "/api/settings", { method: "PUT", headers: { ...j, cookie }, body: JSON.stringify({ ...(pin ? { pin } : {}), settings }) });
    expect((await put({ view: "workspace" })).status).toBe(200);
    expect(loadConfig(dir).view).toBe("workspace");
    expect(app.config.view).toBe("workspace");
    await new Promise((r) => setTimeout(r, 100));
    expect(got).toContainEqual({ type: "ui", view: "workspace" });
    expect((await put({ view: "huge" })).status).toBe(400);
    expect((await put({ view: "minimal", claudeCode: { model: "haiku" } })).status).toBe(400); // mixed with another setting: PIN needed
    expect((await put({ view: "minimal", claudeCode: { model: "haiku" } }, owner.pin)).status).toBe(200);
    expect((await put({}, undefined)).status).toBe(400);
    ws.close();
  });
});

describe("the panels the owner has open", () => {
  it("are kept clear of by the AI's pictures, and the AI is told", async () => {
    const cookie = await boot();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie } });
    await new Promise((r) => ws.on("open", r));
    ws.send(JSON.stringify({ type: "ui.panels", open: ["chat", "tasks"] }));
    await new Promise((r) => setTimeout(r, 100));
    expect(app.stage.openPanels()).toEqual(["chat", "tasks"]);
    expect(app.stage.summary()).toMatch(/chat panel.*schedule panel|schedule panel.*chat panel/);
    ws.send(JSON.stringify({ type: "ui.panels", open: [] }));
    await new Promise((r) => setTimeout(r, 100));
    expect(app.stage.openPanels()).toEqual([]);
    ws.close();
  });
});
