import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { refuseForAgent } from "./settings";
import { FakeProvider } from "./provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const catalog = resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugins");
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };

async function boot() {
  app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "friend-tavily-")), provider: new FakeProvider([]), config: { port: 0, roots: [] }, pluginCatalogDir: catalog });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
afterEach(async () => {
  await app.stop();
});

type Listing = { installed: { id: string; enabled: boolean }[]; integrations: { id: string; installed: boolean; enabled: boolean; state: string; detail: string; secrets: Record<string, boolean>; settings: Record<string, string | boolean> }[] };

describe("the Tavily plugin", () => {
  it("is installed with the PIN, brings its skill, needs the owner's key before it switches on, and never shows the key", async () => {
    const cookie = await boot();
    const h = { ...j, cookie };
    const list = async () => (await (await fetch(base() + "/api/plugins", { headers: { cookie } })).json()) as Listing;
    const tv = async () => (await list()).integrations.find((i) => i.id === "tavily")!;

    expect(await tv()).toMatchObject({ installed: false, state: "not-installed" });
    expect((await fetch(base() + "/api/plugins/install", { method: "POST", headers: h, body: JSON.stringify({ id: "tavily", pin: "000000" }) })).status).toBe(403);
    expect((await fetch(base() + "/api/plugins/install", { method: "POST", headers: h, body: JSON.stringify({ id: "tavily", pin: owner.pin }) })).status).toBe(200);
    expect(await tv()).toMatchObject({ installed: true, enabled: false, state: "needs-setup", detail: expect.stringMatching(/API key/) });
    expect((await list()).installed.map((p) => p.id)).toContain("tavily-search"); // the skill came with it

    const on = (pin = owner.pin) => fetch(base() + "/api/plugins/tavily/enabled", { method: "POST", headers: h, body: JSON.stringify({ enabled: true, pin }) });
    const refused = await on();
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/key first/);

    const saved = await fetch(base() + "/api/settings", { method: "PUT", headers: h, body: JSON.stringify({ pin: owner.pin, settings: { web: { tavilyKey: "tvly-secret-123", tavily: { depth: "advanced", maxResults: 3 } } } }) });
    expect(saved.status).toBe(200);
    expect(JSON.stringify(await saved.json())).not.toContain("tvly-secret-123");
    expect((await on()).status).toBe(200);
    const after = await tv();
    expect(after).toMatchObject({ enabled: true, state: "online", secrets: { apiKey: true }, settings: { depth: "advanced", maxResults: "3" } });
    expect(JSON.stringify(await list())).not.toContain("tvly-secret-123");

    // removing the plugin takes its skill away and switches it off
    expect((await fetch(base() + "/api/plugins/tavily", { method: "DELETE", headers: { cookie } })).status).toBe(200);
    expect(await tv()).toMatchObject({ installed: false, enabled: false });
    expect((await list()).installed.map((p) => p.id)).not.toContain("tavily-search");
  });

  it("is out of the assistant's reach (key, depth, results), and the settings screen refuses a silly number of results", async () => {
    expect(() => refuseForAgent({ web: { tavilyKey: "x" } })).toThrow(/owner/);
    expect(() => refuseForAgent({ web: { tavily: { depth: "advanced" } } })).toThrow(/owner/);
    const cookie = await boot();
    const r = await fetch(base() + "/api/settings", { method: "PUT", headers: { ...j, cookie }, body: JSON.stringify({ pin: owner.pin, settings: { web: { tavily: { maxResults: 99 } } } }) });
    expect(r.status).toBe(400); // out of range is refused by the same schema the AI goes through
  });
});
