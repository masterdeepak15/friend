import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { PcAgent } from "../../../pc-agent/src/agent";
import { AgentStore } from "../../../pc-agent/src/store";
import { createApp } from "../app";
import { FakeProvider } from "../provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
let app: Awaited<ReturnType<typeof createApp>> | undefined;
const agents: PcAgent[] = [];
afterEach(async () => {
  for (const a of agents.splice(0)) await a.stop().catch(() => {});
  await app?.stop();
  app = undefined;
});

const until = async (cond: () => boolean | Promise<boolean>, ms = 8000) => {
  for (let t = 0; t < ms && !(await cond()); t += 25) await new Promise((r) => setTimeout(r, 25));
  if (!(await cond())) throw new Error("timed out waiting");
};

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "friend-pce2e-"));
  const agentPath = join(dir, "agent.js");
  writeFileSync(agentPath, "// the agent file the server hands out");
  app = await createApp({ dataDir: dir, provider: new FakeProvider([[{ type: "done" }]] as never), config: { port: 0, roots: [] }, pluginCatalogDir: join(dir, "none"), pcAgentPath: agentPath });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const j = { "content-type": "application/json" };
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...(init.body ? j : {}), cookie } });
  return { base, api, dir };
}

/** A PC with a fake helper (nothing touches this desktop) that signs in against the real server. */
function makeAgent(base: string, enrollmentId: string, name = "OFFICE-PC", agentSha256?: string) {
  const dir = mkdtempSync(join(tmpdir(), "friend-pce2e-agent-"));
  const store = new AgentStore(join(dir, "agent.db"));
  const shown: string[] = [];
  const events: string[] = [];
  const helperCalls: string[] = [];
  const agent = new PcAgent({
    store,
    helper: {
      call: async (op: string, args: Record<string, unknown> = {}) => {
        helperCalls.push(op);
        if (op === "seal") return { text: Buffer.from(String(args.text)).toString("base64") };
        if (op === "unseal") return { text: Buffer.from(String(args.text), "base64").toString() };
        return { text: `${op} ok` };
      },
      stop() {},
    } as never,
    server: base,
    version: "0.1.97",
    os: "Windows 11",
    host: name,
    ...(agentSha256 ? { agentSha256 } : {}),
    enrollmentId,
    connect: (url, token) => new WebSocket(url, { headers: { authorization: `Bearer ${token}` } }) as never,
    show: (url, code) => shown.push(`${url} ${code}`),
    onRevoked: () => events.push("revoked"),
    onUpdate: (url, sha) => events.push(`update ${url} ${sha.slice(0, 6)}`),
  });
  agents.push(agent);
  return { agent, store, shown, events, helperCalls };
}

const json = (body: unknown, method = "POST") => ({ method, body: JSON.stringify(body) });

describe("a real agent and a real Friend", () => {
  it("add the PC, install, sign in with approval, stay connected, take new permissions, and end when revoked", async () => {
    const t = await boot();
    const added = (await (await t.api("/api/pc", json({ name: "Office", pin: owner.pin }))).json()) as { pc: { id: number }; enrollmentId: string };
    const pc = makeAgent(t.base, added.enrollmentId);
    const started = pc.agent.start();

    // the owner opens the page the agent showed and approves
    await until(() => pc.shown.length > 0);
    const code = pc.shown[0]!.split(" ").at(-1)!;
    expect(pc.shown[0]).toContain(`/pc/approve?code=${code}`);
    expect(((await (await t.api(`/api/pc/enroll/${code}`)).json()) as { name: string }).name).toBe("Office");
    expect((await t.api(`/api/pc/enroll/${code}/approve`, json({ pin: owner.pin, permissions: { control: true, screen: true, shell: false, registry: false, process: false, files: "off", folders: [] } }))).status).toBe(200);
    await started;

    // it connects by itself and shows as online with its status
    await until(async () => ((await (await t.api("/api/pc")).json()) as { pcs: { online: boolean }[] }).pcs[0]?.online === true);
    const listed = (await (await t.api("/api/pc")).json()) as { pcs: { name: string; os: string; host: string; status: { state: string } | null }[] };
    expect(listed.pcs[0]).toMatchObject({ name: "Office", os: "Windows 11", host: "OFFICE-PC" });
    await until(async () => ((await (await t.api("/api/pc")).json()) as { pcs: { status: { state: string } | null }[] }).pcs[0]?.status?.state === "idle");

    // permissions the owner sets reach the PC at once
    await t.api(`/api/pc/${added.pc.id}/permissions`, json({ permissions: { control: true, screen: true, shell: true, registry: false, process: false, files: "read", folders: ["D:\\shop"] }, pin: owner.pin }, "PUT"));
    await until(() => JSON.parse(pc.store.get("permissions") ?? "{}").shell === true);
    expect(JSON.parse(pc.store.get("permissions")!)).toMatchObject({ files: "read", folders: ["D:\\shop"] });

    // revoking ends it: the PC is told, signs out, and the socket closes
    await t.api(`/api/pc/${added.pc.id}/revoke`, json({ pin: owner.pin }));
    await until(() => pc.events.includes("revoked"));
    expect(await pc.agent.session.signedIn()).toBe(false);
    await until(async () => ((await (await t.api("/api/pc")).json()) as { pcs: { online: boolean }[] }).pcs[0]?.online === false);
  }, 30_000);

  it("a PC with an older agent file is told to update itself", async () => {
    const t = await boot();
    const added = (await (await t.api("/api/pc", json({ name: "Office", pin: owner.pin }))).json()) as { enrollmentId: string };
    const pc = makeAgent(t.base, added.enrollmentId, "OFFICE-PC", "f".repeat(64));
    const started = pc.agent.start();
    await until(() => pc.shown.length > 0);
    await t.api(`/api/pc/enroll/${pc.shown[0]!.split(" ").at(-1)}/approve`, json({ pin: owner.pin }));
    await started;
    await until(() => pc.events.some((e) => e.startsWith("update /api/pc/agent.js")));
  }, 30_000);

  it("a socket without a good token is closed at once", async () => {
    const t = await boot();
    const ws = new WebSocket(`${t.base.replace("http", "ws")}/pc`, { headers: { authorization: "Bearer not-a-token" } });
    const code = await new Promise<number>((resolve) => ws.on("close", (c) => resolve(c)));
    expect(code).toBe(4401);
  });
});
