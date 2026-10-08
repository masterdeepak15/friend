import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { decodeToolName, encodeToolName } from "./provider/claude-code/bridge";
import { FakeProvider } from "./provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const FAKE = join(dirname(fileURLToPath(import.meta.url)), "connectors", "testing", "fake-mcp.mjs");
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir = "";
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };

async function boot(existing?: string) {
  dir = existing ?? mkdtempSync(join(tmpdir(), "friend-connroute-"));
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [] } });
  port = (await app.start()).port;
  if (!existing) await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const api = (cookie: string | null, method: string, path: string, body?: unknown) =>
  fetch(base() + "/api/connectors" + path, {
    method,
    headers: { ...(cookie ? { cookie } : {}), ...(body !== undefined ? { "content-type": "application/json" } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const fake = (extra: Record<string, unknown> = {}) => ({ id: "fake", name: "Fake", kind: "stdio", command: process.execPath, args: [FAKE], ...extra });

afterEach(async () => {
  await app?.stop();
});

describe("connector routes", () => {
  it("need a signed-in owner", async () => {
    await boot();
    for (const [m, p, b] of [["GET", "", undefined], ["POST", "", { pin: "1", connector: {} }], ["POST", "/x/enabled", { enabled: true }], ["POST", "/x/reload", {}], ["DELETE", "/x", undefined]] as const) {
      expect((await api(null, m, p, b)).status, `${m} ${p}`).toBe(401);
    }
  });

  it("list what is connected and the ready-made ones to choose from", async () => {
    const cookie = await boot();
    const body = (await (await api(cookie, "GET", "")).json()) as { connectors: unknown[]; presets: { id: string; setup: string[]; warning?: string }[] };
    expect(body.connectors).toEqual([]);
    expect(body.presets.map((p) => p.id)).toEqual(["chrome", "gmail"]);
    expect(body.presets.find((p) => p.id === "gmail")!.setup.join(" ")).toMatch(/Google's own sign-in/);
    expect(body.presets.every((p) => p.setup.length > 0 && !!p.warning)).toBe(true);
  });

  it("adding needs the PIN; a wrong PIN adds nothing", async () => {
    const cookie = await boot();
    expect((await api(cookie, "POST", "", { connector: fake() })).status).toBe(400);
    expect((await api(cookie, "POST", "", { pin: "000000", connector: fake() })).status).toBe(403);
    expect(app.audit).toBeTruthy();
    const list = (await (await api(cookie, "GET", "")).json()) as { connectors: unknown[] };
    expect(list.connectors).toEqual([]);
  });

  it("add, switch off, switch on (PIN), reload and remove", async () => {
    const cookie = await boot();
    const added = await api(cookie, "POST", "", { pin: owner.pin, connector: fake({ env: { FAKE_SECRET: "top-secret-token" } }) });
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ id: "fake", status: "ready", tools: 8, secret: true });
    // the secret is stored, and never comes back
    expect(readFileSync(join(dir, "connectors.json"), "utf8")).toContain("top-secret-token");
    expect(await (await api(cookie, "GET", "")).text()).not.toContain("top-secret-token");

    expect(await (await api(cookie, "POST", "/fake/enabled", { enabled: false })).json()).toMatchObject({ status: "off" });
    expect((await api(cookie, "POST", "/fake/enabled", { enabled: true })).status).toBe(400); // switching on needs the PIN
    expect((await api(cookie, "POST", "/fake/enabled", { enabled: true, pin: "000000" })).status).toBe(403);
    expect(await (await api(cookie, "POST", "/fake/enabled", { enabled: true, pin: owner.pin })).json()).toMatchObject({ status: "ready" });
    expect(await (await api(cookie, "POST", "/fake/reload", {})).json()).toMatchObject({ status: "ready" });
    expect((await api(cookie, "DELETE", "/fake")).status).toBe(200);
    expect((await api(cookie, "DELETE", "/fake")).status).toBe(404);
    expect((await api(cookie, "POST", "/nope/enabled", { enabled: false })).status).toBe(404);
  });

  it("explain a connector that does not start, and refuse an unsafe one", async () => {
    const cookie = await boot();
    const ghost = await api(cookie, "POST", "", { pin: owner.pin, connector: { id: "ghost", name: "Ghost", kind: "stdio", command: "definitely-not-a-real-program" } });
    expect(await ghost.json()).toMatchObject({ status: "error", error: expect.any(String) });
    const insecure = await api(cookie, "POST", "", { pin: owner.pin, connector: { id: "web", name: "Web", kind: "http", url: "http://example.com/mcp" } });
    expect(insecure.status).toBe(400);
    expect(((await insecure.json()) as { error: string }).error).toMatch(/https/);
  });

  it("are recorded in the audit log without any secret, and the tools reach the agent", async () => {
    const cookie = await boot();
    await api(cookie, "POST", "", { pin: owner.pin, connector: fake({ env: { FAKE_SECRET: "top-secret-token" } }) });
    const rows = app.db.prepare("select kind, detail_json from audit_log where kind like 'connector.%'").all() as { kind: string; detail_json: string }[];
    expect(rows.map((r) => r.kind)).toEqual(["connector.added"]);
    expect(JSON.stringify(rows)).not.toContain("top-secret-token");
    expect(app.agent).toBeTruthy();
  });

  it("come back by themselves when Friend starts again", async () => {
    const cookie = await boot();
    await api(cookie, "POST", "", { pin: owner.pin, connector: fake() });
    await app.stop();
    const again = await boot(dir);
    for (let i = 0; i < 100; i++) {
      const list = (await (await api(again, "GET", "")).json()) as { connectors: { status: string }[] };
      if (list.connectors[0]?.status === "ready") break;
      await new Promise((r) => setTimeout(r, 100));
    }
    const final = (await (await api(again, "GET", "")).json()) as { connectors: { status: string; tools: number }[] };
    expect(final.connectors[0]).toMatchObject({ status: "ready", tools: 8 });
  });
});

describe("tool names across the Claude Code bridge", () => {
  it("a connector tool keeps its name through encode and decode", () => {
    for (const n of ["mcp.chrome.take_snapshot", "mcp.gmail.search_emails", "mcp.my-mail.send-email", "plugins.create", "connectors.add"]) {
      expect(decodeToolName(encodeToolName(n))).toBe(n);
      expect(`mcp__friend__${encodeToolName(n)}`.length).toBeLessThanOrEqual(64);
    }
  });
});
