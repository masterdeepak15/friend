import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, saveConfig, type Config } from "./config";
import type { ChromeStatus } from "./connectors/chromePlugin";
import { changeChrome, INTEGRATION_IDS, integrationSummary, integrationViews, isIntegrationId } from "./integrations";

const silent = { status: () => ({ telegram: { state: "off" as const }, twilio: { state: "off" as const } }) } as never;

function cfg(): Config {
  return loadConfig(mkdtempSync(join(tmpdir(), "friend-chromecfg-")));
}
const idle: ChromeStatus = { helper: false, extensionFolder: null, installing: false, error: null, connector: null, extension: "unknown", bundled: true };
const ready = (over: Partial<ChromeStatus> = {}): ChromeStatus => ({
  ...idle,
  helper: true,
  extensionFolder: "C:/Users/me/.chrome-control-mcp/extension",
  connector: { id: "chrome", name: "Chrome control", kind: "stdio", enabled: true, status: "ready", error: null, tools: 33, target: "node index.js", secret: false },
  extension: "connected",
  ...over,
});
const view = (c: Config, s?: ChromeStatus) => integrationViews(c, silent, undefined, undefined, undefined, undefined, undefined, s ? { status: () => s } : undefined).find((v) => v.id === "chrome")!;

describe("the chrome setting", () => {
  it("is off and not installed on a new install, and survives a save", () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-chromecfg-"));
    const c = loadConfig(dir);
    expect(c.chrome).toEqual({ installed: false, enabled: false, remote: false });
    c.chrome = { installed: true, enabled: true, remote: false };
    saveConfig(c);
    expect(loadConfig(dir).chrome).toEqual({ installed: true, enabled: true, remote: false });
  });
  it("reads anything odd in the file as off", () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-chromecfg-"));
    const c = loadConfig(dir);
    saveConfig({ ...c, chrome: { installed: "yes", enabled: 1 } as never });
    expect(loadConfig(dir).chrome).toEqual({ installed: false, enabled: false, remote: false });
  });
});

describe("chrome among the integrations", () => {
  it("is one of them, and the last", () => {
    expect(isIntegrationId("chrome")).toBe(true);
    expect(INTEGRATION_IDS[INTEGRATION_IDS.length - 1]).toBe("chrome");
  });
  it("starts as not installed, and says what it is", () => {
    const v = view(cfg());
    expect(v).toMatchObject({ id: "chrome", name: "Chrome control", installed: false, state: "not-installed" });
    expect(v.description).toMatch(/comes with Friend/i);
  });
  it("shows setup working, then asking for the helper, then off", () => {
    const c = cfg();
    c.chrome.installed = true;
    expect(view(c, { ...idle, installing: true })).toMatchObject({ state: "connecting", detail: expect.stringMatching(/setting up/i) });
    expect(view(c, idle)).toMatchObject({ state: "needs-setup" });
    expect(view(c, { ...idle, error: "The install did not finish." }).detail).toMatch(/did not finish/);
    expect(view(c, ready({ extension: "unknown", connector: null }))).toMatchObject({ state: "off", detail: "Switched off." });
  });
  it("says when the extension is not linked, and when everything works", () => {
    const c = cfg();
    c.chrome = { installed: true, enabled: true, remote: false };
    expect(view(c, ready({ extension: "off" }))).toMatchObject({ state: "needs-setup", detail: expect.stringMatching(/extension/i) });
    expect(view(c, ready())).toMatchObject({ state: "online" });
    expect(view(c, ready({ extension: "unknown" }))).toMatchObject({ state: "online", detail: expect.stringMatching(/check/i) });
  });
  it("shows a failing connector as an error, and a starting one as connecting", () => {
    const c = cfg();
    c.chrome = { installed: true, enabled: true, remote: false };
    const conn = ready().connector!;
    expect(view(c, ready({ connector: { ...conn, status: "error", error: "It did not answer in time." } }))).toMatchObject({ state: "error", detail: "It did not answer in time." });
    expect(view(c, ready({ connector: { ...conn, status: "connecting" } })).state).toBe("connecting");
    expect(view(c, ready({ connector: null })).state).toBe("connecting");
  });
  it("lists the steps with what is done, and the extension folder as a setting (not a secret)", () => {
    const c = cfg();
    c.chrome = { installed: true, enabled: true, remote: false };
    const v = view(c, ready());
    expect(v.steps.map((s) => s.done)).toEqual([true, true, true, true]);
    expect(v.settings).toEqual({ extensionFolder: "C:/Users/me/.chrome-control-mcp/extension" });
    expect(v.secrets).toEqual({});
    expect(view(c, idle).steps.map((s) => s.done)).toEqual([false, false, true, false]);
  });
  it("is not in the assistant's own list: only the owner changes what can drive their browser", () => {
    const c = cfg();
    c.chrome.installed = true;
    const text = integrationSummary(integrationViews(c, silent, undefined, undefined, undefined, undefined, undefined, { status: () => ready() }));
    expect(text).not.toMatch(/Chrome control/);
  });
});

describe("changeChrome", () => {
  it("installs, switches on once set up, switches off, and removes", () => {
    const c = { installed: false, enabled: false, remote: false };
    expect(changeChrome(c, { enabled: true }, true)).toMatch(/not installed yet/);
    expect(changeChrome(c, { install: true }, false)).toBeNull();
    expect(c.installed).toBe(true);
    expect(changeChrome(c, { enabled: true }, false)).toMatch(/set up/i);
    expect(c.enabled).toBe(false);
    expect(changeChrome(c, { enabled: true }, true)).toBeNull();
    expect(c.enabled).toBe(true);
    expect(changeChrome(c, { enabled: false }, true)).toBeNull();
    expect(c.enabled).toBe(false);
    changeChrome(c, { enabled: true }, true);
    expect(changeChrome(c, { remove: true }, true)).toBeNull();
    expect(c).toEqual({ installed: false, enabled: false, remote: false });
  });
});
