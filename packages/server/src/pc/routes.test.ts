import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { Audit } from "../audit";
import { FakeProvider } from "../provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "friend-pcroutes-"));
  const agentPath = join(dir, "agent.js");
  writeFileSync(agentPath, "console.log('the agent');");
  app = await createApp({ dataDir: dir, provider: new FakeProvider([[{ type: "done" }]] as never), config: { port: 0, roots: [] }, pluginCatalogDir: join(dir, "none"), pcAgentPath: agentPath });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const j = { "content-type": "application/json" };
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...(init.body ? j : {}), cookie } });
  const anon = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: init.body ? j : {} });
  return { api, anon, db: app.db, base };
}
const send = (body: unknown, method = "POST") => ({ method, body: JSON.stringify(body) });

describe("adding a Windows PC over HTTP", () => {
  it("walks the whole way: owner adds, the PC starts, the owner approves, the PC gets its tokens and can refresh them", async () => {
    const t = await boot();
    const added = (await (await t.api("/api/pc", send({ name: "Office", pin: owner.pin }))).json()) as { pc: { id: number; permissions: { shell: boolean } }; enrollmentId: string };
    expect(added.pc.permissions.shell).toBe(false);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const start = await t.anon("/api/pc/enroll/start", send({ enrollmentId: added.enrollmentId, challenge, os: "Windows 11", host: "OFFICE-PC" }));
    expect(start.status).toBe(200);
    const s = (await start.json()) as { deviceCode: string; userCode: string; verifyPath: string };
    expect(s.verifyPath).toContain(s.userCode);

    const waiting = await t.anon("/api/pc/enroll/token", send({ deviceCode: s.deviceCode, verifier }));
    expect(waiting.status).toBe(202);

    // only the signed-in owner sees and approves it
    expect((await t.anon(`/api/pc/enroll/${s.userCode}`)).status).toBe(401);
    expect(((await (await t.api(`/api/pc/enroll/${s.userCode}`)).json()) as { name: string; host: string })).toMatchObject({ name: "Office", host: "OFFICE-PC" });
    expect((await t.api(`/api/pc/enroll/${s.userCode}/approve`, send({ pin: "000000" }))).status).toBe(403);
    expect((await t.api(`/api/pc/enroll/${s.userCode}/approve`, send({ pin: owner.pin, permissions: { control: true, screen: true, shell: true, registry: false, process: false, files: "read", folders: ["D:\\shop"] } }))).status).toBe(200);

    const got = (await (await t.anon("/api/pc/enroll/token", send({ deviceCode: s.deviceCode, verifier }))).json()) as { access: string; refresh: string; pcId: number };
    expect(got.access).toBeTruthy();
    const next = await t.anon("/api/pc/token/refresh", send({ refresh: got.refresh }));
    expect(next.status).toBe(200);

    const list = (await (await t.api("/api/pc")).json()) as { pcs: { name: string; online: boolean; permissions: { shell: boolean; files: string } }[] };
    expect(list.pcs).toMatchObject([{ name: "Office", online: false, permissions: { shell: true, files: "read" } }]);
    const kinds = new Audit(t.db).list(100).map((r) => r.kind);
    expect(kinds).toEqual(expect.arrayContaining(["pc.added", "pc.enroll.start", "pc.approved"]));
  });

  it("refuses a wrong verifier, a stranger, and answers the owner-only routes with 401 without a session", async () => {
    const t = await boot();
    const added = (await (await t.api("/api/pc", send({ name: "Office", pin: owner.pin }))).json()) as { enrollmentId: string };
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const s = (await (await t.anon("/api/pc/enroll/start", send({ enrollmentId: added.enrollmentId, challenge, os: "Windows 11", host: "X" }))).json()) as { deviceCode: string; userCode: string };
    const wrong = await t.anon("/api/pc/enroll/token", send({ deviceCode: s.deviceCode, verifier: randomBytes(32).toString("base64url") }));
    expect(wrong.status).toBe(400);
    expect((await t.anon("/api/pc")).status).toBe(401);
    expect((await t.anon("/api/pc", send({ name: "Evil", pin: owner.pin }))).status).toBe(401);
    expect((await t.anon(`/api/pc/enroll/${s.userCode}/approve`, send({ pin: owner.pin }))).status).toBe(401);
    expect((await t.anon("/api/pc/enroll/start", send({ enrollmentId: "nope-nope-nope", challenge, os: "w", host: "h" }))).status).toBe(400);
    expect((await t.anon("/api/pc/enroll/start", send({ junk: 1 }))).status).toBe(400);
  });

  it("changes permissions and revokes with the PIN, and a revoked PC cannot refresh", async () => {
    const t = await boot();
    const added = (await (await t.api("/api/pc", send({ name: "Office", pin: owner.pin }))).json()) as { pc: { id: number }; enrollmentId: string };
    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const s = (await (await t.anon("/api/pc/enroll/start", send({ enrollmentId: added.enrollmentId, challenge, os: "Windows 11", host: "X" }))).json()) as { deviceCode: string; userCode: string };
    await t.api(`/api/pc/enroll/${s.userCode}/approve`, send({ pin: owner.pin }));
    const tok = (await (await t.anon("/api/pc/enroll/token", send({ deviceCode: s.deviceCode, verifier }))).json()) as { refresh: string };

    const perms = { control: true, screen: false, shell: false, registry: false, process: false, files: "off", folders: [] };
    expect((await t.api(`/api/pc/${added.pc.id}/permissions`, send({ permissions: perms, pin: "000000" }, "PUT"))).status).toBe(403);
    expect((await t.api(`/api/pc/${added.pc.id}/permissions`, send({ permissions: perms, pin: owner.pin }, "PUT"))).status).toBe(200);
    expect((await t.api(`/api/pc/${added.pc.id}/permissions`, send({ permissions: { ...perms, files: "everything" }, pin: owner.pin }, "PUT"))).status).toBe(400);

    expect((await t.api(`/api/pc/${added.pc.id}/revoke`, send({ pin: owner.pin }))).status).toBe(200);
    expect((await t.anon("/api/pc/token/refresh", send({ refresh: tok.refresh }))).status).toBe(401);
    const list = (await (await t.api("/api/pc")).json()) as { pcs: { revoked: boolean }[] };
    expect(list.pcs[0]!.revoked).toBe(true);
    expect((await t.api(`/api/pc/${added.pc.id}`, send({ pin: owner.pin }, "DELETE"))).status).toBe(200);
    expect(((await (await t.api("/api/pc")).json()) as { pcs: unknown[] }).pcs).toHaveLength(0);
  });

  it("will not take two PCs with the same name", async () => {
    const t = await boot();
    expect((await t.api("/api/pc", send({ name: "Office", pin: owner.pin }))).status).toBe(200);
    expect((await t.api("/api/pc", send({ name: "office", pin: owner.pin }))).status).toBe(400);
  });
});

describe("what a new PC downloads", () => {
  it("gives the owner the install command and the links, and serves the script to a valid enrollment only", async () => {
    const t = await boot();
    const added = (await (await t.api("/api/pc", send({ name: "Office", pin: owner.pin }))).json()) as { enrollmentId: string; install: { command: string; ps1Url: string; cmdUrl: string } | null };
    expect(added.install).toBeTruthy();
    expect(added.install!.command).toContain(`install.ps1?enrollment=${added.enrollmentId}`);
    expect(added.install!.command).toContain("-ExecutionPolicy Bypass");
    const ps1 = await t.anon(`/api/pc/install.ps1?enrollment=${added.enrollmentId}`);
    expect(ps1.status).toBe(200);
    const text = await ps1.text();
    expect(text).toContain("$pcName = 'Office'");
    expect(text).toMatch(/\$agentSha = '[0-9a-f]{64}'/);
    expect((await t.anon("/api/pc/install.ps1?enrollment=not-a-real-one")).status).toBe(404);
    expect((await t.anon("/api/pc/install.ps1")).status).toBe(404);
    const cmd = await t.anon(`/api/pc/install.cmd?enrollment=${added.enrollmentId}`);
    expect(cmd.status).toBe(200);
    expect(cmd.headers.get("content-disposition")).toContain("install-friend-pc-agent.cmd");
  });

  it("serves the agent file to an install link or to a signed-in PC, with its checksum, and to nobody else", async () => {
    const t = await boot();
    const added = (await (await t.api("/api/pc", send({ name: "Office", pin: owner.pin }))).json()) as { pc: { id: number }; enrollmentId: string };
    expect((await t.anon("/api/pc/agent.js")).status).toBe(401);
    expect((await t.anon("/api/pc/agent.js?enrollment=nope")).status).toBe(401);
    const file = await t.anon(`/api/pc/agent.js?enrollment=${added.enrollmentId}`);
    expect(file.status).toBe(200);
    expect(await file.text()).toContain("the agent");
    expect(file.headers.get("x-agent-sha256")).toMatch(/^[0-9a-f]{64}$/);

    const verifier = randomBytes(32).toString("base64url");
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const s = (await (await t.anon("/api/pc/enroll/start", send({ enrollmentId: added.enrollmentId, challenge, os: "Windows 11", host: "X" }))).json()) as { deviceCode: string; userCode: string };
    await t.api(`/api/pc/enroll/${s.userCode}/approve`, send({ pin: owner.pin }));
    const tok = (await (await t.anon("/api/pc/enroll/token", send({ deviceCode: s.deviceCode, verifier }))).json()) as { access: string };
    const withToken = await fetch(`${t.base}/api/pc/agent.js`, { headers: { authorization: `Bearer ${tok.access}` } });
    expect(withToken.status).toBe(200);
    // the install link is used up: it no longer serves the file
    expect((await t.anon(`/api/pc/agent.js?enrollment=${added.enrollmentId}`)).status).toBe(401);
    await t.api(`/api/pc/${added.pc.id}/revoke`, send({ pin: owner.pin }));
    expect((await fetch(`${t.base}/api/pc/agent.js`, { headers: { authorization: `Bearer ${tok.access}` } })).status).toBe(401);
  });
});

describe("approving on the screen, and starting a control session", () => {
  it("serves the page the owner approves on, with nothing from the request in it", async () => {
    const t = await boot();
    const res = await t.anon("/pc/approve?code=%3Cscript%3Ealert(1)%3C/script%3E");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const html = await res.text();
    expect(html).toContain("Approve this PC");
    expect(html).not.toContain("alert(1)");
  });

  it("lets the owner start and stop a control session only on a PC that is connected and allowed", async () => {
    const t = await boot();
    const added = (await (await t.api("/api/pc", send({ name: "Office", pin: owner.pin }))).json()) as { pc: { id: number } };
    expect((await t.anon(`/api/pc/${added.pc.id}/control`, send({ action: "stop" }))).status).toBe(401);
    expect((await t.api(`/api/pc/${added.pc.id}/control`, send({ action: "start" }))).status).toBe(400); // control is off for this PC
    await t.api(`/api/pc/${added.pc.id}/permissions`, send({ permissions: { control: true, screen: true, shell: false, registry: false, process: false, files: "off", folders: [] }, pin: owner.pin }, "PUT"));
    expect((await t.api(`/api/pc/${added.pc.id}/control`, send({ action: "start", minutes: 10 }))).status).toBe(409); // not connected
    expect((await t.api(`/api/pc/${added.pc.id}/control`, send({ action: "stop" }))).status).toBe(200);
    expect((await t.api("/api/pc/999/control", send({ action: "stop" }))).status).toBe(404);
    expect((await t.api(`/api/pc/${added.pc.id}/control`, send({ action: "dance" }))).status).toBe(400);
  });
});

