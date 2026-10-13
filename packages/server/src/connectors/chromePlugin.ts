import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ConnectorView, McpHub } from "./hub";
import { chromeInstalled, quickConnect, quickInstall, readExtensionState, type QuickRunner } from "./quick";

const here = dirname(fileURLToPath(import.meta.url));
const ID = "chrome";

/**
 * Where the copy of Chrome control that comes with Friend is: next to the program when installed from npm
 * (dist/chrome-control/dist/index.js), in the repository when run from source (packages/chrome-control/dist/index.js).
 * FRIEND_CHROME_CONTROL points at another copy. Null when there is none.
 */
export function bundledChromeControl(): string | null {
  const candidates = [process.env.FRIEND_CHROME_CONTROL, resolve(here, "chrome-control/dist/index.js"), resolve(here, "../../../chrome-control/dist/index.js")];
  for (const c of candidates) if (c && existsSync(c)) return c;
  return null;
}

export interface ChromeStatus {
  /** Chrome control's helper and the extension copy are set up in the owner's home folder. */
  helper: boolean;
  /** The folder to load in chrome://extensions, once set up. */
  extensionFolder: string | null;
  /** Setup is running now. */
  installing: boolean;
  /** One plain sentence about the last thing that failed, or null. */
  error: string | null;
  /** The connector as the screens show it, or null when Friend has none. */
  connector: ConnectorView | null;
  /** Whether the Chrome extension is switched on and talking to the program (as last asked). */
  extension: "connected" | "off" | "unknown";
  /** This Friend has its own copy of Chrome control inside it. */
  bundled: boolean;
}

/** Whether Chrome's "started debugging this browser" banner is hidden: in the Chrome that is open, and on its shortcuts. */
export interface BannerStatus {
  /** This Friend has its own Chrome control, which knows how to hide the banner. */
  supported: boolean;
  platform?: string;
  running?: boolean;
  /** The open Chrome was started with the flag that hides the banner. Null when Chrome is not open. */
  hidden?: boolean | null;
  shortcuts?: { withFlag: number; total: number } | null;
  /** One plain sentence when the state could not be read. */
  error?: string;
}

export interface BannerResult {
  ok: boolean;
  message: string;
  patched?: number;
  failed?: number;
}

export interface ChromePluginDeps {
  hub: McpHub;
  run: QuickRunner;
  /** The owner's home folder (tests). */
  home?: string;
  /** Chrome control's index.js that comes with Friend, or null. */
  bundled: string | null;
}

/** Chrome control as a plugin of Friend: set it up, connect it, and say where it stands. It never decides what may run: every browser action still asks the owner first. */
export class ChromePlugin {
  private installing: Promise<void> | null = null;
  private error: string | null = null;
  private extension: ChromeStatus["extension"] = "unknown";
  private asking: Promise<ChromeStatus["extension"]> | null = null;
  private serving: Promise<void> | null = null;

  constructor(private deps: ChromePluginDeps) {}

  status(): ChromeStatus {
    const found = chromeInstalled(this.deps.home);
    const connector = this.deps.hub.list().find((c) => c.id === ID) ?? null;
    return {
      helper: found.installed,
      extensionFolder: found.extensionFolder,
      installing: this.installing !== null,
      error: this.error,
      connector,
      extension: connector?.enabled && connector.status === "ready" ? this.extension : "unknown",
      bundled: this.deps.bundled !== null,
    };
  }

  /** Sets up the helper and the extension copy with the program that comes with Friend. Only one at a time. */
  setup(): Promise<void> {
    if (this.installing) return this.installing;
    this.error = null;
    this.installing = Promise.resolve(); // marked at once: the program below starts before the line after it runs
    this.installing = (async () => {
      try {
        const r = await quickInstall(ID, { hub: this.deps.hub, run: this.deps.run, home: this.deps.home, bundled: this.deps.bundled });
        this.error = r.ok ? null : r.message;
      } catch (e) {
        this.error = `The install did not finish: ${(e as Error).message}`;
      } finally {
        this.installing = null;
      }
    })();
    return this.installing;
  }

  /** Adds or switches on the connector and learns whether the extension is linked. */
  async connect(): Promise<void> {
    this.error = null;
    try {
      const r = await quickConnect(ID, { hub: this.deps.hub, run: this.deps.run, home: this.deps.home, bundled: this.deps.bundled });
      this.extension = r.extension;
      if (!r.ok) this.error = r.connector ? r.message : /not (set up|installed)/i.test(r.message) ? "Chrome control is not set up on this PC yet. Install it first." : r.message;
    } catch (e) {
      this.error = (e as Error).message;
    }
  }

  /** Asks the program whether the extension is linked now (the owner may have switched it on since). One question at a time, however many screens look. */
  refresh(): Promise<ChromeStatus["extension"]> {
    const c = this.deps.hub.list().find((x) => x.id === ID);
    const tool = this.deps.hub.toolSpecs().find((t) => t.name === `mcp.${ID}.status`);
    if (!c || !c.enabled || c.status !== "ready" || !tool) return Promise.resolve("unknown");
    if (this.asking) return this.asking;
    this.asking = (async () => {
      try {
        const r = await this.deps.hub.call(tool.name, {});
        this.extension = r.isError ? "unknown" : readExtensionState(r.text);
      } catch {
        this.extension = "unknown";
      } finally {
        this.asking = null;
      }
      return this.extension;
    })();
    return this.asking;
  }

  /**
   * Starts Chrome control's own MCP server in the background (the one other PCs reach through Friend's /chrome/mcp). It is the
   * program's own "start": it does nothing when the server is already running, and it keeps running after Friend stops.
   */
  startServer(): Promise<void> {
    const entry = this.deps.bundled;
    if (!entry) return Promise.resolve();
    if (this.serving) return this.serving;
    this.serving = this.deps
      .run(process.execPath, [entry, "start"])
      .then(() => {})
      .finally(() => {
        this.serving = null;
      });
    return this.serving;
  }

  /** Runs one of Chrome control's own commands that answer with a line of JSON. */
  private async ask(command: string): Promise<Record<string, unknown> | null> {
    const entry = this.deps.bundled;
    if (!entry) return null;
    const r = await this.deps.run(process.execPath, [entry, command]);
    const line = r.stdout.split(/\r?\n/).reverse().find((l) => l.trim().startsWith("{"));
    if (!line) return null;
    try {
      return JSON.parse(line) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  /** Whether the open Chrome has the flag that hides the banner, and how many shortcuts do. Changes nothing. */
  async bannerStatus(): Promise<BannerStatus> {
    if (!this.deps.bundled) return { supported: false };
    const s = await this.ask("flag-status").catch(() => null);
    if (!s || typeof s.running !== "boolean") return { supported: true, error: "Could not read Chrome's state." };
    const sc = s.shortcuts as { withFlag?: number; total?: number } | null | undefined;
    return {
      supported: true,
      platform: String(s.platform ?? ""),
      running: s.running,
      hidden: typeof s.hidden === "boolean" ? s.hidden : null,
      shortcuts: sc && typeof sc.total === "number" ? { withFlag: sc.withFlag ?? 0, total: sc.total } : null,
    };
  }

  /** Adds the flag to the Chrome shortcuts. It takes effect the next time Chrome starts. */
  async hideBanner(): Promise<BannerResult> {
    if (!this.deps.bundled) return { ok: false, message: "This Friend has no copy of Chrome control to do that." };
    const r = await this.ask("flag").catch(() => null);
    const c = r?.counts as { patched?: number; already?: number; failed?: number } | null | undefined;
    if (!r || !c) return { ok: false, message: "Could not change the shortcuts." };
    const patched = c.patched ?? 0;
    const failed = c.failed ?? 0;
    const already = c.already ?? 0;
    if (r.ok !== true) return { ok: false, patched, failed, message: failed ? "Windows would not let Friend change those shortcuts (shared ones may need an administrator)." : "No Chrome shortcut was found to change." };
    const bits = [patched ? `Added the flag to ${patched} shortcut${patched === 1 ? "" : "s"}.` : "", already ? `${already} already had it.` : "", failed ? `${failed} could not be changed (shared ones may need an administrator).` : ""].filter(Boolean);
    return { ok: true, patched, failed, message: `${bits.join(" ")} It counts when Chrome starts: if Chrome is open now, restart it.` };
  }

  /** Closes Chrome politely and starts it again with the flag and the tabs back. */
  async restartChrome(): Promise<BannerResult> {
    if (!this.deps.bundled) return { ok: false, message: "This Friend has no copy of Chrome control to do that." };
    const r = await this.ask("chrome-restart").catch(() => null);
    if (!r || typeof r.ok !== "boolean") return { ok: false, message: "Could not restart Chrome." };
    return { ok: r.ok, message: String(r.message ?? (r.ok ? "Chrome was restarted." : "Chrome was not restarted.")) };
  }

  /** Switches the connector off but keeps it listed. */
  async disconnect(): Promise<void> {
    if (!this.deps.hub.list().some((c) => c.id === ID)) return;
    await this.deps.hub.setEnabled(ID, false);
    this.extension = "unknown";
  }

  /** Removes the connector. The helper and the extension stay: other programs on this PC use them too. */
  async forget(): Promise<void> {
    if (this.deps.hub.list().some((c) => c.id === ID)) await this.deps.hub.remove(ID);
    this.extension = "unknown";
    this.error = null;
  }
}
