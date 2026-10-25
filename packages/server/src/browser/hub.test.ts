import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { BrowserConfig } from "../config";
import { UNTRUSTED } from "../web/search";
import { findChrome } from "./chrome";
import { BrowserHub } from "./hub";

const cfg = (over: Partial<BrowserConfig> = {}): BrowserConfig => ({ installed: true, enabled: true, chromePath: "", timeoutSec: 15, maxChars: 2000, ...over });
const HAS_CHROME = findChrome("") !== null;

describe("finding Chrome", () => {
  const only = (...files: string[]) => (p: string) => files.includes(p.replace(/\\/g, "/"));
  it("uses the path the owner gave and nothing else, even when another browser is installed", () => {
    expect(findChrome("/opt/mine/chrome", { platform: "linux", isFile: only("/opt/mine/chrome", "/usr/bin/google-chrome"), env: { PATH: "/usr/bin" } })).toBe("/opt/mine/chrome");
    expect(findChrome("/opt/wrong/chrome", { platform: "linux", isFile: only("/usr/bin/google-chrome"), env: { PATH: "/usr/bin" } })).toBeNull();
  });
  it("looks in the usual places on each system, Chrome before Edge", () => {
    const env = { PROGRAMFILES: "C:/Program Files", LOCALAPPDATA: "C:/Users/me/AppData/Local" };
    expect(findChrome("", { platform: "win32", env, isFile: only("C:/Program Files/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Google/Chrome/Application/chrome.exe") })?.replace(/\\/g, "/")).toBe("C:/Program Files/Google/Chrome/Application/chrome.exe");
    expect(findChrome("", { platform: "win32", env, isFile: only("C:/Program Files/Microsoft/Edge/Application/msedge.exe") })?.replace(/\\/g, "/")).toBe("C:/Program Files/Microsoft/Edge/Application/msedge.exe");
    expect(findChrome("", { platform: "darwin", env: {}, isFile: only("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome") })).toBe("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome");
    expect(findChrome("", { platform: "linux", env: { PATH: "/bin:/usr/bin" }, isFile: only("/usr/bin/chromium") })?.replace(/\\/g, "/")).toBe("/usr/bin/chromium");
    expect(findChrome("", { platform: "linux", env: { PATH: "/bin" }, isFile: () => false })).toBeNull();
  });
});

describe("the safe browser refuses before it starts anything", () => {
  it("will not open an address on this PC or the network, however it is written", async () => {
    const hub = new BrowserHub({ config: () => cfg() });
    for (const bad of ["http://127.0.0.1:8787/", "http://localhost/", "http://192.168.1.1/", "http://[::1]/", "file:///C:/Windows/win.ini", "javascript:alert(1)", "https://user:pw@example.com/", "not a url"]) {
      const r = await hub.read(bad);
      expect(r.ok, bad).toBe(false);
      const s = await hub.screenshot(bad);
      expect(s.ok, bad).toBe(false);
    }
  });

  it("says plainly when there is no Chrome or Edge to use", async () => {
    const hub = new BrowserHub({ config: () => cfg({ chromePath: join(tmpdir(), "no-such-chrome.exe") }), vet: async (u) => ({ ok: true, url: u, host: "example.com" }) });
    expect(await hub.read("https://example.com/")).toEqual({ ok: false, error: expect.stringMatching(/could not find Chrome or Edge/) });
  });
});

describe.skipIf(!HAS_CHROME)("the safe browser with a real Chrome", () => {
  let site: Server;
  let other: Server;
  let sitePort = 0;
  let otherPort = 0;
  let otherHits = 0;
  const root = mkdtempSync(join(tmpdir(), "friend-browser-test-"));
  // the real rule would refuse a local page: this one lets through only the test site, and counts what it refuses
  const refused: string[] = [];
  const vet = async (u: string) => {
    const p = new URL(u);
    if (p.hostname === "127.0.0.1" && Number(p.port) === sitePort) return { ok: true as const, url: u, host: p.hostname };
    refused.push(u);
    return { ok: false as const, error: "That address is on this PC or your network, so Friend will not open it." };
  };
  const hub = () => new BrowserHub({ config: () => cfg(), vet, tmpRoot: root, settleMs: 300 });
  const now = () => readdirSync(root).filter((n) => n.startsWith("friend-browser-"));
  // Windows lets go of a closed browser's files a moment late, so "nothing left" is waited for, not assumed
  const left = async () => {
    for (let i = 0; i < 60 && now().length > 0; i++) await new Promise((r) => setTimeout(r, 250));
    return now();
  };

  beforeAll(async () => {
    other = createServer((_req, res) => {
      otherHits++;
      res.end("x");
    });
    await new Promise<void>((r) => other.listen(0, "127.0.0.1", r));
    otherPort = (other.address() as AddressInfo).port;
    site = createServer((req, res) => {
      if (req.url === "/popup") {
        res.end("<p>popup</p>");
      } else if (req.url === "/hang") {
        /* never answers */
      } else if (req.url === "/") {
        res.setHeader("content-type", "text/html");
        res.end(`<!doctype html><title>Test page</title><body><div id=x>loading</div><img src="http://127.0.0.1:${otherPort}/pixel.png">
<script>
document.getElementById("x").textContent = "Drawn by a script. WebSocket is " + typeof WebSocket + ".";
fetch("http://127.0.0.1:${otherPort}/fetch").catch(() => {});
window.open("/popup");
</script><p style="height:2500px">tall</p>`);
      } else {
        res.statusCode = 404;
        res.end("no");
      }
    });
    await new Promise<void>((r) => site.listen(0, "127.0.0.1", r));
    sitePort = (site.address() as AddressInfo).port;
  });
  afterAll(async () => {
    site.closeAllConnections();
    await new Promise((r) => site.close(r));
    await new Promise((r) => other.close(r));
  });

  it("reads what a script drew, marks it untrusted, never lets the page reach anything else, and leaves nothing behind", async () => {
    const r = await hub().read(`http://127.0.0.1:${sitePort}/`);
    expect(r.ok).toBe(true);
    const text = r.ok ? r.text : "";
    expect(text.startsWith(UNTRUSTED)).toBe(true);
    expect(text).toMatch(/Title: Test page/);
    expect(text).toMatch(/Drawn by a script\. WebSocket is undefined\./);
    expect(otherHits).toBe(0); // the picture and the fetch to another address were stopped
    expect(refused.some((u) => u.startsWith(`http://127.0.0.1:${otherPort}/`))).toBe(true);
    expect(await left()).toEqual([]);
  }, 40_000);

  it("takes a picture (the first screen, or the whole page)", async () => {
    const one = await hub().screenshot(`http://127.0.0.1:${sitePort}/`);
    expect(one).toMatchObject({ ok: true, mime: "image/jpeg" });
    const full = await hub().screenshot(`http://127.0.0.1:${sitePort}/`, true);
    expect(full.ok && one.ok && full.data.length >= one.data.length).toBe(true);
    expect(one.ok && Buffer.from(one.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(await left()).toEqual([]);
  }, 60_000);

  it("does one page at a time, and gives up on a page that never answers", async () => {
    const h = new BrowserHub({ config: () => cfg({ timeoutSec: 5 }), vet, tmpRoot: root, settleMs: 100 });
    const slow = h.read(`http://127.0.0.1:${sitePort}/hang`);
    await new Promise((r) => setTimeout(r, 400));
    expect(await h.read(`http://127.0.0.1:${sitePort}/`)).toEqual({ ok: false, error: expect.stringMatching(/busy/) });
    expect(await slow).toEqual({ ok: false, error: expect.stringMatching(/too long/) });
    expect(await left()).toEqual([]);
  }, 40_000);

  it("stops when the request is stopped", async () => {
    const stop = new AbortController();
    const p = hub().read(`http://127.0.0.1:${sitePort}/hang`, stop.signal);
    setTimeout(() => stop.abort(), 500);
    expect(await p).toEqual({ ok: false, error: expect.stringMatching(/stopped/) });
    expect(await left()).toEqual([]);
  }, 40_000);
});
