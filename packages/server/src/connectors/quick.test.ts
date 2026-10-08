import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { McpHub } from "./hub";
import { PRESETS } from "./presets";
import { chromeInstalled, isQuickPreset, quickCheck, quickConnect, quickInstall, readExtensionState, type QuickRunner } from "./quick";
import { ConnectorStore } from "./store";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-chrome.mjs");
const chrome = PRESETS.find((p) => p.id === "chrome")!;
const real = chrome.connector;

/** A home folder, optionally with chrome-control already set up in it. */
function home(setUp: boolean): string {
  const h = mkdtempSync(join(tmpdir(), "friend-quick-home-"));
  if (setUp) install(h);
  return h;
}
function install(h: string) {
  const base = join(h, ".chrome-control-mcp");
  mkdirSync(join(base, "extension"), { recursive: true });
  mkdirSync(join(base, "native-host"), { recursive: true });
  writeFileSync(join(base, "token"), "secret-token");
  writeFileSync(join(base, "extension", "manifest.json"), "{}");
}

let hub: McpHub;
afterEach(async () => {
  chrome.connector = real;
  await hub?.close();
});
/** Points the one-click connector at the fake program, so no real npx runs. */
function useFake(...extra: string[]) {
  chrome.connector = { ...real, command: process.execPath, args: [FAKE, ...extra] };
}
const newHub = () => (hub = new McpHub(new ConnectorStore(mkdtempSync(join(tmpdir(), "friend-quick-hub-")))));
const never: QuickRunner = async () => {
  throw new Error("nothing should be run");
};

describe("the preset", () => {
  it("is one click, with the fixed command (the same as: claude mcp add chrome-control -- npx -y chrome-control-mcp)", () => {
    expect(chrome.quick).toBe(true);
    expect(real).toEqual({ id: "chrome", name: "Chrome control", kind: "stdio", command: "npx", args: ["-y", "chrome-control-mcp"] });
    expect(PRESETS.find((p) => p.id === "gmail")!.quick).toBeUndefined(); // the others still need their steps and fields
    expect(isQuickPreset("chrome")).toBe(true);
    expect(isQuickPreset("gmail")).toBe(false);
    expect(isQuickPreset("nope")).toBe(false);
  });
});

describe("quickCheck", () => {
  it("says to install it first, with the command and the one manual step, when it is not on this PC", () => {
    const c = quickCheck("chrome", { home: home(false) })!;
    expect(c).toMatchObject({ preset: "chrome", ready: false, installCommand: "npx -y chrome-control-mcp setup", extensionFolder: null });
    expect(c.message).toMatch(/not installed on this PC yet\. Please install it first, then press Connect again/);
    expect(c.manualStep).toMatch(/chrome:\/\/extensions.*Developer mode.*Load unpacked/);
  });
  it("is ready when its helper, token and extension are there, and says where the extension is", () => {
    const h = home(true);
    const c = quickCheck("chrome", { home: h })!;
    expect(c).toMatchObject({ ready: true, installCommand: null, manualStep: null });
    expect(c.extensionFolder).toBe(join(h, ".chrome-control-mcp", "extension"));
  });
  it("needs all of it: a token alone, or an extension without the helper, is not installed", () => {
    const h = home(false);
    mkdirSync(join(h, ".chrome-control-mcp"), { recursive: true });
    writeFileSync(join(h, ".chrome-control-mcp", "token"), "x");
    expect(chromeInstalled(h).installed).toBe(false);
    const g = home(true);
    mkdirSync(join(g, ".chrome-control-mcp", "native-host"), { recursive: true });
    expect(chromeInstalled(g).installed).toBe(true);
    const k = home(true);
    writeFileSync(join(k, ".chrome-control-mcp", "extension", "manifest.json"), "{}");
    expect(chromeInstalled(k).installed).toBe(true);
    const bare = home(false);
    mkdirSync(join(bare, ".chrome-control-mcp", "extension"), { recursive: true });
    writeFileSync(join(bare, ".chrome-control-mcp", "extension", "manifest.json"), "{}");
    expect(chromeInstalled(bare).installed).toBe(false);
  });
  it("knows nothing about a connector that is not one click", () => {
    expect(quickCheck("gmail", { home: home(true) })).toBeNull();
    expect(quickCheck("../x", {})).toBeNull();
  });
});

describe("quickInstall", () => {
  it("runs chrome-control's own setup in the background, without touching Claude's settings or Chrome's shortcuts, and reports the extension folder", async () => {
    const h = home(false);
    const calls: string[][] = [];
    const run: QuickRunner = async (cmd, args, opts) => {
      calls.push([cmd, ...args]);
      opts?.onLine?.("Creating the token…");
      opts?.onLine?.("Installing the native host…");
      install(h);
      return { code: 0, stdout: "" };
    };
    const seen: string[] = [];
    const r = await quickInstall("chrome", { hub: newHub(), run, home: h }, (l) => seen.push(l));
    expect(calls).toEqual([["npx", "-y", "chrome-control-mcp", "setup", "--no-claude", "--no-open", "--no-flag"]]);
    expect(r.ok).toBe(true);
    expect(r.extensionFolder).toBe(join(h, ".chrome-control-mcp", "extension"));
    expect(r.message).toMatch(/Chrome control is installed.*Load unpacked/);
    expect(r.output).toContain("Installing the native host");
    expect(seen).toEqual(["Creating the token…", "Installing the native host…"]);
  });
  it("says so, and tells how to do it by hand, when the install fails or leaves nothing behind", async () => {
    const failed = await quickInstall("chrome", { hub: newHub(), run: async () => ({ code: 1, stdout: "npm ERR! network" }), home: home(false) });
    expect(failed.ok).toBe(false);
    expect(failed.message).toMatch(/did not finish.*npx -y chrome-control-mcp setup/);
    expect(failed.output).toContain("network");
    const empty = await quickInstall("chrome", { hub: newHub(), run: async () => ({ code: 0, stdout: "done" }), home: home(false) });
    expect(empty.ok).toBe(false);
  });
  it("only installs a one-click connector, and never runs anything else", async () => {
    const r = await quickInstall("gmail", { hub: newHub(), run: never, home: home(false) });
    expect(r).toMatchObject({ ok: false, message: "That is not a one-click connector." });
  });
});

describe("quickConnect", () => {
  it("does nothing when it is not installed", async () => {
    useFake();
    const h = newHub();
    const r = await quickConnect("chrome", { hub: h, run: never, home: home(false) });
    expect(r).toMatchObject({ ok: false, connector: null });
    expect(r.message).toMatch(/Please install it first/);
    expect(h.list()).toEqual([]);
  });

  it("adds the connector with its fixed command, connects it, and says the Chrome extension is connected", async () => {
    useFake();
    const h = newHub();
    const r = await quickConnect("chrome", { hub: h, run: never, home: home(true) });
    expect(r).toMatchObject({ ok: true, extension: "connected", connector: { id: "chrome", name: "Chrome control", status: "ready", tools: 3 } });
    expect(r.message).toMatch(/Chrome control is on with 3 tools\. Your Chrome extension is connected/);
    expect(h.list().map((c) => c.id)).toEqual(["chrome"]);
    expect(h.has("mcp.chrome.take_snapshot")).toBe(true);
  });

  it("says what to do when the extension is not linked yet", async () => {
    useFake("--ext-off");
    const h2 = home(true);
    const r = await quickConnect("chrome", { hub: newHub(), run: never, home: h2 });
    expect(r).toMatchObject({ ok: true, extension: "off" });
    expect(r.message).toMatch(/extension is not connected yet\. Click its icon in Chrome and switch it on/);
    expect(r.message).toContain(join(h2, ".chrome-control-mcp", "extension"));
  });

  it("still works, and says to check the extension, when its status cannot be read", async () => {
    useFake("--status-error");
    const r = await quickConnect("chrome", { hub: newHub(), run: never, home: home(true) });
    expect(r).toMatchObject({ ok: true, extension: "unknown" });
    expect(r.message).toMatch(/Check that the Chrome extension is loaded/);
  });

  it("does not add a second copy: a connector that is already there is reloaded, or switched on again", async () => {
    useFake();
    const h = newHub();
    const hm = home(true);
    await quickConnect("chrome", { hub: h, run: never, home: hm });
    const again = await quickConnect("chrome", { hub: h, run: never, home: hm });
    expect(again.ok).toBe(true);
    expect(h.list()).toHaveLength(1);
    await h.setEnabled("chrome", false);
    const back = await quickConnect("chrome", { hub: h, run: never, home: hm });
    expect(back).toMatchObject({ ok: true, connector: { status: "ready" } });
    expect(h.list()).toHaveLength(1);
    expect(h.list()[0]!.enabled).toBe(true);
  });

  it("reports a program that does not start, in words, and keeps it listed so it can be reloaded", async () => {
    chrome.connector = { ...real, command: "definitely-not-a-real-program", args: [] };
    const h = newHub();
    const r = await quickConnect("chrome", { hub: h, run: never, home: home(true) });
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/Chrome control is saved, but it did not start/);
    expect(r.connector!.status).toBe("error");
    expect(h.list()).toHaveLength(1);
  });

  it("refuses a connector that is not one click", async () => {
    const r = await quickConnect("gmail", { hub: newHub(), run: never, home: home(true) });
    expect(r).toMatchObject({ ok: false, message: "That is not a one-click connector." });
  });
});

describe("readExtensionState", () => {
  it("reads the real status output", () => {
    expect(readExtensionState(JSON.stringify({ connected: true, mode: "peer", extension: true }))).toBe("connected");
    expect(readExtensionState(JSON.stringify({ connected: true, extension: false }))).toBe("off");
    expect(readExtensionState(JSON.stringify({ connected: false }))).toBe("off");
    expect(readExtensionState(JSON.stringify({ connected: true }))).toBe("connected");
  });
  it("understands words too, and does not guess about anything else", () => {
    expect(readExtensionState("the extension is not connected yet")).toBe("off");
    expect(readExtensionState("Extension connected on port 8765")).toBe("connected");
    expect(readExtensionState("something unexpected")).toBe("unknown");
    expect(readExtensionState("")).toBe("unknown");
    expect(readExtensionState("{broken json")).toBe("unknown");
  });
});
