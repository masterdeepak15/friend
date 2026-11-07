import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { loadConfig, sanitizeCodeRunner } from "./config";
import { FakeProvider } from "./provider/fake";
import { applySettings } from "./settings";

describe("the codeRunner setting", () => {
  it("accepts the three values and turns anything else into auto", () => {
    expect(sanitizeCodeRunner("sandbox")).toBe("sandbox");
    expect(sanitizeCodeRunner("docker")).toBe("docker");
    expect(sanitizeCodeRunner("auto")).toBe("auto");
    for (const bad of ["banana", 42, undefined, null, ["docker"]]) expect(sanitizeCodeRunner(bad)).toBe("auto");
  });

  it("is read from the saved file, and is auto when the file has nothing", () => {
    const d = mkdtempSync(join(tmpdir(), "friend-cr-"));
    expect(loadConfig(d).codeRunner).toBe("auto");
    const e = mkdtempSync(join(tmpdir(), "friend-cr-"));
    writeFileSync(join(e, "config.json"), JSON.stringify({ codeRunner: "docker" }));
    expect(loadConfig(e).codeRunner).toBe("docker");
  });

  it("is changed by the settings patch, and a wrong value is refused", () => {
    const c = loadConfig(mkdtempSync(join(tmpdir(), "friend-cr-")));
    expect(applySettings(c, { codeRunner: "sandbox" }).changed).toContain("codeRunner");
    expect(c.codeRunner).toBe("sandbox");
    expect(() => applySettings(c, { codeRunner: "banana" })).toThrow();
    expect(c.codeRunner).toBe("sandbox");
  });
});

describe("the codeRunner setting on the settings screen route", () => {
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  afterEach(async () => {
    await app?.stop();
  });
  it("is shown by GET /api/settings", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-cr-"));
    app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [], codeRunner: "sandbox" } });
    const port = (await app.start()).port;
    const j = { "content-type": "application/json" };
    await fetch(`http://127.0.0.1:${port}/api/setup`, { method: "POST", headers: j, body: JSON.stringify({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" }) });
    const login = await fetch(`http://127.0.0.1:${port}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: "correct horse battery" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const view = await (await fetch(`http://127.0.0.1:${port}/api/settings`, { headers: { cookie } })).json();
    expect(view.codeRunner).toBe("sandbox");
    // changing where code runs is a safety setting: it needs the PIN
    const without = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: "PUT", headers: { ...j, cookie }, body: JSON.stringify({ settings: { codeRunner: "docker" } }) });
    expect(without.ok).toBe(false);
    const withPin = await fetch(`http://127.0.0.1:${port}/api/settings`, { method: "PUT", headers: { ...j, cookie }, body: JSON.stringify({ pin: "123456", settings: { codeRunner: "docker" } }) });
    expect(withPin.ok).toBe(true);
  });
});
