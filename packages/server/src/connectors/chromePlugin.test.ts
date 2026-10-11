import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { bundledChromeControl, ChromePlugin } from "./chromePlugin";
import { McpHub } from "./hub";
import type { QuickRunner } from "./quick";
import { ConnectorStore } from "./store";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-chrome.mjs");

function home(setUp: boolean): string {
  const h = mkdtempSync(join(tmpdir(), "friend-chromeplugin-home-"));
  if (setUp) setUpIn(h);
  return h;
}
function setUpIn(h: string) {
  const base = join(h, ".chrome-control-mcp");
  mkdirSync(join(base, "extension"), { recursive: true });
  mkdirSync(join(base, "native-host"), { recursive: true });
  writeFileSync(join(base, "token"), "secret-token");
  writeFileSync(join(base, "extension", "manifest.json"), "{}");
}

let hub: McpHub;
afterEach(async () => {
  await hub?.close();
});
function make(h: string, opts: { run?: QuickRunner; bundled?: string | null } = {}) {
  hub = new McpHub(new ConnectorStore(mkdtempSync(join(tmpdir(), "friend-chromeplugin-hub-"))));
  const plugin = new ChromePlugin({ hub, run: opts.run ?? (async () => ({ code: 0, stdout: "" })), home: h, bundled: opts.bundled === undefined ? FAKE : opts.bundled });
  return plugin;
}

describe("ChromePlugin.status", () => {
  it("starts empty: nothing set up, no connector, nothing known about Chrome", () => {
    const p = make(home(false));
    expect(p.status()).toEqual({ helper: false, extensionFolder: null, installing: false, error: null, connector: null, extension: "unknown", bundled: true });
  });
  it("knows the helper and the extension folder once Chrome control is set up", () => {
    const h = home(true);
    expect(make(h).status()).toMatchObject({ helper: true, extensionFolder: join(h, ".chrome-control-mcp", "extension") });
  });
  it("says when this Friend has no copy of Chrome control inside it", () => {
    expect(make(home(false), { bundled: null }).status().bundled).toBe(false);
  });
});

describe("ChromePlugin.setup", () => {
  it("runs the copy that comes with Friend, shows 'installing' while it works, and then the helper is there", async () => {
    const h = home(false);
    let during = false;
    let p!: ChromePlugin;
    const run: QuickRunner = async (cmd, args) => {
      during = p.status().installing;
      expect([cmd, args[0]]).toEqual([process.execPath, FAKE]);
      setUpIn(h);
      return { code: 0, stdout: "" };
    };
    p = make(h, { run });
    await p.setup();
    expect(during).toBe(true);
    expect(p.status()).toMatchObject({ installing: false, helper: true, error: null });
  });
  it("keeps the failure as a sentence the screen can show, and forgets it on the next try", async () => {
    const h = home(false);
    let fail = true;
    const p = make(h, {
      run: async () => {
        if (!fail) setUpIn(h);
        return { code: fail ? 1 : 0, stdout: fail ? "boom" : "" };
      },
    });
    await p.setup();
    expect(p.status()).toMatchObject({ installing: false, helper: false });
    expect(p.status().error).toMatch(/did not finish/);
    fail = false;
    await p.setup();
    expect(p.status()).toMatchObject({ helper: true, error: null });
  });
  it("does not start a second setup while one is running", async () => {
    const h = home(false);
    let runs = 0;
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const p = make(h, {
      run: async () => {
        runs++;
        await gate;
        setUpIn(h);
        return { code: 0, stdout: "" };
      },
    });
    const a = p.setup();
    const b = p.setup();
    release();
    await Promise.all([a, b]);
    expect(runs).toBe(1);
  });
});

describe("ChromePlugin.connect", () => {
  it("connects Friend to Chrome control and reports that the extension is linked", async () => {
    const p = make(home(true));
    await p.connect();
    expect(p.status()).toMatchObject({ connector: { id: "chrome", status: "ready", tools: 3, enabled: true }, extension: "connected", error: null });
  });
  it("tells the owner to set it up first when it is not", async () => {
    const p = make(home(false));
    await p.connect();
    expect(p.status().connector).toBeNull();
    expect(p.status().error).toMatch(/not set up/);
  });
  it("can be asked again what Chrome says", async () => {
    const p = make(home(true));
    await p.connect();
    expect(await p.refresh()).toBe("connected");
  });
  it("asks Chrome only once at a time, however many screens look at once", async () => {
    const p = make(home(true));
    await p.connect();
    const real = hub.call.bind(hub);
    let calls = 0;
    hub.call = async (name, args) => {
      calls++;
      await new Promise((r) => setTimeout(r, 50));
      return real(name, args);
    };
    await Promise.all([p.refresh(), p.refresh(), p.refresh()]);
    expect(calls).toBe(1);
    await p.refresh();
    expect(calls).toBe(2);
  });
  it("has nothing to ask when it is not connected", async () => {
    expect(await make(home(true)).refresh()).toBe("unknown");
  });
});

describe("ChromePlugin.disconnect and forget", () => {
  it("switches the connector off but keeps it listed", async () => {
    const p = make(home(true));
    await p.connect();
    await p.disconnect();
    expect(p.status().connector).toMatchObject({ enabled: false, status: "off" });
    expect(p.status().extension).toBe("unknown");
  });
  it("forget removes the connector, and leaves the helper and the extension where they are (other programs use them)", async () => {
    const h = home(true);
    const p = make(h);
    await p.connect();
    await p.forget();
    expect(p.status()).toMatchObject({ connector: null, helper: true });
  });
  it("does nothing, quietly, when there is no connector", async () => {
    const p = make(home(true));
    await p.disconnect();
    await p.forget();
    expect(p.status().connector).toBeNull();
  });
});

describe("bundledChromeControl", () => {
  it("finds nothing for a path that is not there, and honours FRIEND_CHROME_CONTROL when it is", () => {
    const keep = process.env.FRIEND_CHROME_CONTROL;
    try {
      process.env.FRIEND_CHROME_CONTROL = join(tmpdir(), "definitely-not-here", "index.js");
      const none = bundledChromeControl();
      expect(none === null || none !== process.env.FRIEND_CHROME_CONTROL).toBe(true);
      process.env.FRIEND_CHROME_CONTROL = FAKE;
      expect(bundledChromeControl()).toBe(FAKE);
    } finally {
      if (keep === undefined) delete process.env.FRIEND_CHROME_CONTROL;
      else process.env.FRIEND_CHROME_CONTROL = keep;
    }
  });
});
