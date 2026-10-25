import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { findChrome } from "./browser/chrome";
import { FakeProvider } from "./provider/fake";
import { refuseForAgent } from "./settings";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const catalog = resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugins");
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };

async function boot() {
  app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "friend-browserplug-")), provider: new FakeProvider([]), config: { port: 0, roots: [] }, pluginCatalogDir: catalog });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
afterEach(async () => {
  await app.stop();
});

type Listing = { installed: { id: string }[]; integrations: { id: string; installed: boolean; enabled: boolean; state: string; detail: string; settings: Record<string, string | boolean> }[] };

describe("the safe browser plugin", () => {
  it("is installed with the PIN and brings its skill, will not switch on without a browser program, and is removed with its skill", async () => {
    const cookie = await boot();
    const h = { ...j, cookie };
    const list = async () => (await (await fetch(base() + "/api/plugins", { headers: { cookie } })).json()) as Listing;
    const bw = async () => (await list()).integrations.find((i) => i.id === "browser")!;
    const settings = (browser: object) => fetch(base() + "/api/settings", { method: "PUT", headers: h, body: JSON.stringify({ pin: owner.pin, settings: { browser } }) });
    const on = () => fetch(base() + "/api/plugins/browser/enabled", { method: "POST", headers: h, body: JSON.stringify({ enabled: true, pin: owner.pin }) });

    expect(await bw()).toMatchObject({ installed: false, state: "not-installed" });
    expect((await fetch(base() + "/api/plugins/install", { method: "POST", headers: h, body: JSON.stringify({ id: "browser", pin: "000000" }) })).status).toBe(403);
    expect((await fetch(base() + "/api/plugins/install", { method: "POST", headers: h, body: JSON.stringify({ id: "browser", pin: owner.pin }) })).status).toBe(200);
    expect((await list()).installed.map((p) => p.id)).toContain("ai-browser");

    // a path that is not a browser: it cannot be switched on, and the page says why
    expect((await settings({ chromePath: join(tmpdir(), "no-such-browser.exe") })).status).toBe(200);
    expect(await bw()).toMatchObject({ state: "needs-setup", detail: expect.stringMatching(/cannot find Chrome or Edge/) });
    const refused = await on();
    expect(refused.status).toBe(400);
    expect(((await refused.json()) as { error: string }).error).toMatch(/cannot find Chrome or Edge/);

    // settings are checked
    expect((await settings({ timeoutSec: 1 })).status).toBe(400);
    expect((await settings({ maxChars: 10_000_000 })).status).toBe(400);
    expect((await settings({ chromePath: 'C:\\x"y' })).status).toBe(400);
    expect((await settings({ timeoutSec: 30, maxChars: 5000, chromePath: "" })).status).toBe(200);
    expect(await bw()).toMatchObject({ settings: { timeoutSec: "30", maxChars: "5000", chromePath: "" } });

    if (findChrome("")) {
      expect((await on()).status).toBe(200);
      expect(await bw()).toMatchObject({ enabled: true, state: "online" });
    }

    expect((await fetch(base() + "/api/plugins/browser", { method: "DELETE", headers: { cookie } })).status).toBe(200);
    expect(await bw()).toMatchObject({ installed: false, enabled: false });
    expect((await list()).installed.map((p) => p.id)).not.toContain("ai-browser");
  }, 30_000);

  it("is out of the assistant's reach", () => {
    expect(() => refuseForAgent({ browser: { chromePath: "C:/anything.exe" } })).toThrow(/owner/);
  });
});
