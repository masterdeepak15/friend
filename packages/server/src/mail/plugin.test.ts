import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loadConfig, type Config } from "../config";
import { changeMail, integrationViews } from "../integrations";
import { FakeProvider } from "../provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

const card = (c: Config, counts?: { total: number; online: number; needsSignIn: number }) => integrationViews(c, { status: () => ({}) as never }, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined, counts ? { counts: () => counts } : undefined).find((v) => v.id === "mail")!;
const fresh = () => loadConfig(mkdtempSync(join(tmpdir(), "friend-mailplugin-")));
const account = { name: "Support", address: "support@corp.com", imap: { host: "imap.corp.com", port: 993, tls: true }, smtp: { host: "smtp.corp.com", port: 465, secure: true }, username: "support@corp.com", owners: ["boss@corp.com"], systems: ["@monitor.io"] };

describe("Mailboxes as a plugin on the plugins screen", () => {
  it("is offered as an integration that starts not installed, saying what it does", () => {
    const v = card(fresh());
    expect(v).toMatchObject({ id: "mail", name: "Mailboxes", installed: false, enabled: false, state: "not-installed" });
    expect(v.description).toMatch(/only mail from you/i);
  });

  it("goes through install, switching on and removing, and cannot be switched on before it is installed", () => {
    const c = fresh();
    expect(changeMail(c.mail, { enabled: true })).toMatch(/not installed yet/);
    expect(changeMail(c.mail, { install: true })).toBeNull();
    expect(card(c)).toMatchObject({ installed: true, enabled: false, state: "off" });
    expect(changeMail(c.mail, { enabled: true })).toBeNull();
    expect(card(c)).toMatchObject({ enabled: true, state: "needs-setup", detail: expect.stringMatching(/Add a mailbox/) });
    expect(changeMail(c.mail, { remove: true })).toBeNull();
    expect(c.mail).toEqual({ installed: false, enabled: false });
  });

  it("shows how many mailboxes work, and asks to fix a refused password", () => {
    const c = fresh();
    changeMail(c.mail, { install: true });
    changeMail(c.mail, { enabled: true });
    expect(card(c, { total: 2, online: 2, needsSignIn: 0 })).toMatchObject({ state: "online", detail: expect.stringContaining("2 of 2 mailboxes online") });
    expect(card(c, { total: 1, online: 0, needsSignIn: 0 })).toMatchObject({ state: "connecting" });
    expect(card(c, { total: 2, online: 1, needsSignIn: 1 })).toMatchObject({ state: "needs-setup", detail: expect.stringMatching(/sign-in/) });
    expect(card(c, { total: 2, online: 2, needsSignIn: 0 }).steps.map((s) => s.done)).toEqual([true, true, true]);
  });
});

describe("the mailbox routes", () => {
  async function boot(check = async () => {}) {
    const dir = mkdtempSync(join(tmpdir(), "friend-mailroutes-"));
    app = await createApp({ dataDir: dir, provider: new FakeProvider([[{ type: "done" }]] as never), config: { port: 0, roots: [] }, pluginCatalogDir: join(dir, "none"), mailCheck: check });
    const { port } = await app.start();
    const base = `http://127.0.0.1:${port}`;
    const j = { "content-type": "application/json" };
    await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...(init.body ? j : {}), cookie } });
    const body = (b: unknown, method = "POST") => ({ method, body: JSON.stringify(b) });
    return { dir, api, body, anon: (path: string) => fetch(base + path) };
  }
  const install = async (t: Awaited<ReturnType<typeof boot>>) => {
    await t.api("/api/plugins/install", t.body({ id: "mail", pin: owner.pin }));
    await t.api("/api/plugins/mail/enabled", t.body({ enabled: true, pin: owner.pin }));
  };

  it("are closed until the plugin is installed, and closed to anyone not signed in", async () => {
    const t = await boot();
    expect((await t.anon("/api/mail/accounts")).status).toBe(401);
    expect((await t.api("/api/mail/accounts")).status).toBe(409);
    expect((await t.api("/api/mail/accounts", t.body({ ...account, password: "pw", pin: owner.pin }))).status).toBe(409);
    await install(t);
    expect((await t.api("/api/mail/accounts")).status).toBe(200);
    expect(loadConfig(t.dir).mail).toEqual({ installed: true, enabled: true });
  });

  it("add a mailbox with the PIN after its login was tried, and never give the password back", async () => {
    let tried = 0;
    const t = await boot(async () => void tried++);
    await install(t);
    expect((await t.api("/api/mail/accounts", t.body({ ...account, password: "s3cret-app-pw", pin: "000000" }))).status).toBe(403);
    expect(tried).toBe(0);
    const res = await t.api("/api/mail/accounts", t.body({ ...account, password: "s3cret-app-pw", pin: owner.pin }));
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("s3cret-app-pw");
    expect(JSON.parse(text).account).toMatchObject({ name: "Support", hasPassword: true, owners: ["boss@corp.com"], ladder: { send: "ask", reply: "ask", forward: "ask" } });
    expect(tried).toBe(1);
    const listed = await (await t.api("/api/mail/accounts")).text();
    expect(listed).not.toContain("s3cret-app-pw");
    expect(JSON.parse(listed).accounts).toHaveLength(1);
    // not in the settings file, the database, or anywhere in the data folder in clear text
    expect(readFileSync(join(t.dir, "config.json"), "utf8")).not.toContain("s3cret-app-pw");
    expect(readFileSync(join(t.dir, "oauth-vault.json"), "utf8")).not.toContain("s3cret-app-pw");
    expect((await t.api("/api/mail/accounts", t.body({ ...account, password: "x", pin: owner.pin }))).status).toBe(409); // same name
  });

  it("save nothing when the login is refused, and say why in plain words", async () => {
    const t = await boot(async () => {
      throw new Error("imap.corp.com refused the sign-in. Check the address and the password.");
    });
    await install(t);
    const res = await t.api("/api/mail/accounts", t.body({ ...account, password: "wrong", pin: owner.pin }));
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toContain("refused the sign-in");
    expect(((await (await t.api("/api/mail/accounts")).json()) as { accounts: unknown[] }).accounts).toEqual([]);
  });

  it("check what is sent: an address that is not one, a missing password", async () => {
    const t = await boot();
    await install(t);
    expect((await t.api("/api/mail/accounts", t.body({ ...account, owners: ["not an address"], password: "pw", pin: owner.pin }))).status).toBe(400);
    expect((await t.api("/api/mail/accounts", t.body({ ...account, pin: owner.pin }))).status).toBe(400);
  });

  it("change the approval ladder and the owners with the PIN, and remove a mailbox with its password", async () => {
    const t = await boot();
    await install(t);
    const made = (await (await t.api("/api/mail/accounts", t.body({ ...account, password: "pw1", pin: owner.pin }))).json()) as { account: { id: number } };
    const id = made.account.id;
    expect((await t.api(`/api/mail/accounts/${id}/ladder`, t.body({ ladder: { send: "ask", reply: "auto", forward: "ask" }, pin: "000000" }, "PUT"))).status).toBe(403);
    const ok = await t.api(`/api/mail/accounts/${id}/ladder`, t.body({ ladder: { send: "ask", reply: "auto", forward: "ask" }, pin: owner.pin }, "PUT"));
    expect(((await ok.json()) as { account: { ladder: { reply: string } } }).account.ladder.reply).toBe("auto");
    const patched = await t.api(`/api/mail/accounts/${id}`, t.body({ owners: ["Boss@Corp.com", "me@home.org"], pin: owner.pin }, "PATCH"));
    expect(((await patched.json()) as { account: { owners: string[] } }).account.owners).toEqual(["boss@corp.com", "me@home.org"]);
    expect((await t.api(`/api/mail/accounts/${id}`, t.body({ pin: "000000" }, "DELETE"))).status).toBe(403);
    expect((await t.api(`/api/mail/accounts/${id}`, t.body({ pin: owner.pin }, "DELETE"))).status).toBe(200);
    expect(((await (await t.api("/api/mail/accounts")).json()) as { accounts: unknown[] }).accounts).toEqual([]);
    expect(readFileSync(join(t.dir, "oauth-vault.json"), "utf8").includes("pw1")).toBe(false);
  });
});
