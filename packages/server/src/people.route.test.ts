import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { People } from "./people";
import { FakeProvider } from "./provider/fake";

const DIM = 128;
function face(seed: number): number[] {
  let s = seed * 9301 + 49297;
  return Array.from({ length: DIM }, () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280 - 0.5;
  });
}
type App = Awaited<ReturnType<typeof createApp>>;
let app: App | undefined;
afterEach(async () => {
  await app?.stop();
});
const j = { "content-type": "application/json" };

async function boot() {
  const dir = mkdtempSync(join(tmpdir(), "friend-peopleroute-"));
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [] } });
  const port = (await app.start()).port;
  const base = `http://127.0.0.1:${port}`;
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" }) });
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: "correct horse battery" }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const people = new People(app.db, dir);
  const a = people.introduce({ name: "Priya", relation: "sister", embedding: face(1) }).id;
  people.introduce({ name: "Dev", relation: "friend", embedding: face(2) });
  const req = (path: string, body?: unknown, signedIn = true) =>
    fetch(`${base}${path}`, { method: body === undefined ? "GET" : "POST", headers: { ...j, ...(signedIn ? { cookie } : {}) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { req, people, a };
}

describe("the people list on the settings screen", () => {
  it("is shown to the signed-in owner, with names but no face numbers", async () => {
    const t = await boot();
    const res = await t.req("/api/people");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { name: string; relation: string }[];
    expect(body.map((p) => p.name)).toEqual(["Dev", "Priya"]);
    expect(JSON.stringify(body)).not.toMatch(/embedding|vec/);
  });

  it("is not shown to anyone who is not signed in", async () => {
    const t = await boot();
    expect((await t.req("/api/people", undefined, false)).status).toBe(401);
  });

  it("removes one person after the PIN, and not with a wrong or missing PIN", async () => {
    const t = await boot();
    expect((await t.req("/api/people/remove", { id: t.a })).ok).toBe(false);
    expect((await t.req("/api/people/remove", { id: t.a, pin: "000000" })).ok).toBe(false);
    expect(t.people.list()).toHaveLength(2);
    expect((await t.req("/api/people/remove", { id: t.a, pin: "123456" })).ok).toBe(true);
    expect(t.people.list().map((p) => p.name)).toEqual(["Dev"]);
  });

  it("forgets everyone after the PIN", async () => {
    const t = await boot();
    expect((await t.req("/api/people/forget", { pin: "000000" })).ok).toBe(false);
    expect(t.people.list()).toHaveLength(2);
    expect((await t.req("/api/people/forget", { pin: "123456" })).ok).toBe(true);
    expect(t.people.list()).toEqual([]);
  });

  it("writes down who was removed, without any face data", async () => {
    const t = await boot();
    await t.req("/api/people/remove", { id: t.a, pin: "123456" });
    const rows = JSON.stringify(app!.db.prepare("select * from audit_log where kind like 'people.%'").all());
    expect(rows).toContain("people.removed");
    expect(rows).not.toMatch(/embedding|vec/);
  });
});
