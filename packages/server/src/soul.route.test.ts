import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { FakeProvider } from "./provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir = "";
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };

async function boot() {
  dir = mkdtempSync(join(tmpdir(), "friend-soul-route-"));
  app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [] } });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
afterEach(async () => {
  await app?.stop();
});

describe("/api/soul", () => {
  it("needs a signed-in owner", async () => {
    await boot();
    expect((await fetch(base() + "/api/soul")).status).toBe(401);
    expect((await fetch(base() + "/api/soul", { method: "PUT", headers: j, body: JSON.stringify({ text: "x", pin: "123456" }) })).status).toBe(401);
  });

  it("starts with the default soul, already written to memory as soul.md", async () => {
    const cookie = await boot();
    const got = (await (await fetch(base() + "/api/soul", { headers: { cookie } })).json()) as { text: string; isDefault: boolean; max: number };
    expect(got.isDefault).toBe(true);
    expect(got.text).toMatch(/personal assistant of one person/);
    expect(readFileSync(join(dir, "memory", "soul.md"), "utf8")).toMatch(/Purpose/);
  });

  it("changes only with the right PIN, keeps the old one, and can go back", async () => {
    const cookie = await boot();
    const put = (text: string, pin: string) => fetch(base() + "/api/soul", { method: "PUT", headers: { ...j, cookie }, body: JSON.stringify({ text, pin }) });
    expect((await put("# Soul\nYou are a coach.", "000000")).status).toBe(403);
    expect((await (await fetch(base() + "/api/soul", { headers: { cookie } })).json() as { isDefault: boolean }).isDefault).toBe(true);
    const ok = await put("# Soul\nYou are a coach.", owner.pin);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ text: "# Soul\nYou are a coach.", isDefault: false, versions: [expect.objectContaining({ at: expect.any(Number) })] });
    expect((await put("x".repeat(5000), owner.pin)).status).toBe(400);
    const back = await fetch(base() + "/api/soul/restore", { method: "POST", headers: { ...j, cookie }, body: JSON.stringify({ to: "previous", pin: owner.pin }) });
    expect(await back.json()).toMatchObject({ isDefault: true });
    const wrong = await fetch(base() + "/api/soul/restore", { method: "POST", headers: { ...j, cookie }, body: JSON.stringify({ to: "previous", pin: "000000" }) });
    expect(wrong.status).toBe(403);
    const again = await fetch(base() + "/api/soul/restore", { method: "POST", headers: { ...j, cookie }, body: JSON.stringify({ to: "default", pin: owner.pin }) });
    expect(await again.json()).toMatchObject({ isDefault: true });
  });
});
