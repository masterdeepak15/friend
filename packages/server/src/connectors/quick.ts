import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { McpHub } from "./hub";
import { PRESETS, type Preset } from "./presets";

/** What a one-click connector needs, found out without starting anything. */
export interface QuickCheck {
  /** The preset id, such as "chrome". */
  preset: string;
  name: string;
  /** Everything it needs is on this PC, so it can be connected now. */
  ready: boolean;
  /** One plain sentence for the person. */
  message: string;
  /** What to run in a terminal to install it by hand. */
  installCommand: string | null;
  /** The part nobody can do for you (Chrome does not allow silent installs of extensions), when there is one. */
  manualStep: string | null;
  /** Where the Chrome extension is, once installed. */
  extensionFolder: string | null;
}

export interface QuickConnectResult {
  ok: boolean;
  /** The connector as the screen shows it. */
  connector: { id: string; name: string; status: string; error: string | null; tools: number } | null;
  /** Whether the Chrome extension is switched on and talking to the program. */
  extension: "connected" | "off" | "unknown";
  message: string;
}

export interface QuickInstallResult {
  ok: boolean;
  /** The last lines the installer printed. */
  output: string;
  extensionFolder: string | null;
  message: string;
}

export type QuickRunner = (cmd: string, args: string[], opts?: { onLine?: (line: string) => void }) => Promise<{ code: number; stdout: string }>;

export interface QuickDeps {
  hub: McpHub;
  run: QuickRunner;
  /** The person's home folder (tests). */
  home?: string;
  /** The copy of Chrome control that comes with Friend (its index.js). Without it the npm package is used. */
  bundled?: string | null;
}

const find = (id: string): Preset | undefined => PRESETS.find((p) => p.id === id && p.quick);
export const isQuickPreset = (id: string): boolean => !!find(id);

/** The program a one-click connector starts: Friend's own node on the copy that comes with it, or the npm package. */
function programFor(preset: Preset, bundled: string | null | undefined): { command: string; args: string[] } {
  return bundled ? { command: process.execPath, args: [bundled] } : { command: preset.connector.command, args: [...preset.connector.args] };
}

const MANUAL_EXTENSION =
  "One step only you can do, because Chrome does not allow programs to install extensions silently: open chrome://extensions, turn on Developer mode (top right), click Load unpacked and choose the folder shown above. Then click the extension's icon and switch it on.";

/** chrome-control keeps its token, the extension and the Chrome helper in this folder once `setup` has run. */
function chromeFolder(home: string): string {
  return join(home, ".chrome-control-mcp");
}

export function chromeInstalled(home = homedir()): { installed: boolean; extensionFolder: string | null } {
  const base = chromeFolder(home);
  const ext = join(base, "extension");
  const installed = existsSync(join(base, "token")) && existsSync(join(ext, "manifest.json")) && existsSync(join(base, "native-host"));
  return { installed, extensionFolder: installed ? ext : null };
}

export function quickCheck(id: string, deps: Pick<QuickDeps, "home" | "bundled"> = {}): QuickCheck | null {
  const preset = find(id);
  if (!preset) return null;
  const c = chromeInstalled(deps.home);
  if (c.installed) {
    return { preset: id, name: preset.name, ready: true, message: "Chrome control is installed on this PC.", installCommand: null, manualStep: null, extensionFolder: c.extensionFolder };
  }
  return {
    preset: id,
    name: preset.name,
    ready: false,
    message: deps.bundled
      ? "Chrome control comes with Friend, but it is not set up on this PC yet. Press Install to set it up, then Connect."
      : "Chrome control is not installed on this PC yet. Please install it first, then press Connect again.",
    installCommand: deps.bundled ? `"${process.execPath}" "${deps.bundled}" setup` : "npx -y chrome-control-mcp setup",
    manualStep: MANUAL_EXTENSION,
    extensionFolder: null,
  };
}

/** Runs chrome-control's own one-time setup in the background: its helper, a copy of the extension. It does not touch Claude's settings, Chrome's shortcuts, or open any window. */
export async function quickInstall(id: string, deps: QuickDeps, onLine?: (line: string) => void): Promise<QuickInstallResult> {
  if (!find(id)) return { ok: false, output: "", extensionFolder: null, message: "That is not a one-click connector." };
  const lines: string[] = [];
  const collect = (l: string) => {
    lines.push(l);
    onLine?.(l);
  };
  const setup = ["setup", "--no-claude", "--no-open", "--no-flag"];
  const r = deps.bundled ? await deps.run(process.execPath, [deps.bundled, ...setup], { onLine: collect }) : await deps.run("npx", ["-y", "chrome-control-mcp", ...setup], { onLine: collect });
  const after = chromeInstalled(deps.home);
  const output = (lines.length ? lines : r.stdout.split(/\r?\n/)).filter((l) => l.trim()).slice(-12).join("\n");
  if (r.code !== 0 || !after.installed) {
    const byHand = deps.bundled ? `"${process.execPath}" "${deps.bundled}" setup` : "npx -y chrome-control-mcp setup";
    return { ok: false, output, extensionFolder: null, message: `The install did not finish. You can run it yourself in a terminal: ${byHand}` };
  }
  return { ok: true, output, extensionFolder: after.extensionFolder, message: `Chrome control is installed. ${MANUAL_EXTENSION}` };
}

/** What the program's own status tool says about the Chrome extension. */
export function readExtensionState(text: string): "connected" | "off" | "unknown" {
  try {
    const o = JSON.parse(text) as { extension?: unknown; connected?: unknown };
    if (typeof o.extension === "boolean") return o.extension ? "connected" : "off";
    if (typeof o.connected === "boolean") return o.connected ? "connected" : "off";
  } catch {
    /* not JSON: read the words */
  }
  const t = text.toLowerCase();
  if (/not connected|disconnected|no extension|extension is (off|not)|waiting for (the )?extension|not enabled|disabled/.test(t)) return "off";
  if (/extension[^.\n]*connected|connected[^.\n]*extension|"connected"\s*:\s*true|bridge[^.\n]*connected/.test(t)) return "connected";
  return "unknown";
}

/** Adds the connector with its fixed command (or switches it on again), connects, and says whether the Chrome side is ready too. */
export async function quickConnect(id: string, deps: QuickDeps): Promise<QuickConnectResult> {
  const preset = find(id);
  if (!preset) return { ok: false, connector: null, extension: "unknown", message: "That is not a one-click connector." };
  const check = quickCheck(id, deps)!;
  const program = programFor(preset, deps.bundled);
  if (!check.ready) return { ok: false, connector: null, extension: "unknown", message: check.message };

  const { hub } = deps;
  let existing = hub.list().find((c) => c.id === preset.connector.id);
  // a connector saved for another copy (npx, or Friend in a folder it has since left) would start the wrong program: replace it
  const saved = existing ? hub.command(existing.id) : null;
  if (existing && deps.bundled && (!saved || saved.command !== program.command || saved.args.length !== program.args.length || saved.args.some((a, i) => a !== program.args[i]))) {
    await hub.remove(existing.id);
    existing = undefined;
  }
  const view = existing ? (existing.enabled ? await hub.reload(existing.id) : await hub.setEnabled(existing.id, true)) : await hub.add({ ...preset.connector, ...program });
  const connector = { id: view.id, name: view.name, status: view.status, error: view.error, tools: view.tools };
  if (view.status !== "ready") {
    return { ok: false, connector, extension: "unknown", message: `${preset.name} is saved, but it did not start: ${view.error ?? "unknown error"}` };
  }
  const statusTool = hub.toolSpecs().find((t) => t.name === `mcp.${view.id}.status`);
  let extension: QuickConnectResult["extension"] = "unknown";
  if (statusTool) {
    const r = await hub.call(statusTool.name, {});
    if (!r.isError) extension = readExtensionState(r.text);
  }
  const base = `${preset.name} is on with ${view.tools} tools.`;
  const message =
    extension === "connected"
      ? `${base} Your Chrome extension is connected. Friend can use Chrome now (it still asks before each action).`
      : extension === "off"
        ? `${base} But the Chrome extension is not connected yet. Click its icon in Chrome and switch it on (if it is not loaded: chrome://extensions, Developer mode, Load unpacked, then choose ${check.extensionFolder}).`
        : `${base} Check that the Chrome extension is loaded and switched on (click its icon in Chrome).`;
  return { ok: true, connector, extension, message };
}
