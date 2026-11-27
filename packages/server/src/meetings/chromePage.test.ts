import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { findChrome } from "../browser/chrome";
import { ChromeMeetingPage } from "./chromePage";
import { domFor } from "./dom";
import type { Line } from "./logic";
import { MeetingSession } from "./session";
import { DEFAULT_PREFS, type MeetingStatus } from "./store";

// A page shaped like the Teams one: a page that offers the app, the guest name, a lobby, the meeting with live captions and a chat.
const FIXTURE = `<!doctype html><html><body><div id="app"></div><script>
const app = document.getElementById("app");
window.chatLog = [];
function landing() { app.innerHTML = '<h1>Open Microsoft Teams</h1><button id="web">Continue on this browser</button>'; document.getElementById("web").onclick = prejoin; }
function prejoin() { app.innerHTML = '<input data-tid="prejoin-display-name-input" placeholder="Type your name"><div role="switch" aria-label="Camera" aria-checked="true" data-tid="toggle-video"></div><button data-tid="prejoin-join-button">Join now</button>';
  document.querySelector('[data-tid=toggle-video]').onclick = (e) => e.target.setAttribute("aria-checked", "false");
  document.querySelector('[data-tid=prejoin-join-button]').onclick = () => { window.guest = document.querySelector("input").value; lobby(); }; }
function lobby() { app.innerHTML = '<p>Someone in the meeting should let you in soon</p>'; setTimeout(meeting, 1200); }
function meeting() {
  app.innerHTML = '<button data-tid="hangup-button">Leave</button><button data-tid="chat-button">Chat</button><div id="chat" style="display:none"><div role="textbox" contenteditable="true" data-tid="ckeditor" style="min-height:20px;border:1px solid"></div></div><div id="cc"></div>';
  document.querySelector('[data-tid=hangup-button]').onclick = () => { app.innerHTML = '<h2>You left the meeting</h2>'; };
  document.querySelector('[data-tid=chat-button]').onclick = () => { document.getElementById("chat").style.display = "block"; };
  document.addEventListener("keydown", (e) => { if (e.key === "Enter") { const b = document.querySelector('[data-tid=ckeditor]'); if (b && b.innerText.trim()) { window.chatLog.push(b.innerText.trim()); b.innerText = ""; e.preventDefault(); } } });
  const say = (who, words, at) => setTimeout(() => { const cc = document.getElementById("cc"); const d = document.createElement("div"); d.innerHTML = '<span data-tid="author"></span><span data-tid="closed-caption-text"></span>'; d.querySelector("[data-tid=author]").textContent = who; cc.appendChild(d); const parts = words.split(" "); parts.forEach((_, i) => setTimeout(() => { d.querySelector("[data-tid=closed-caption-text]").textContent = parts.slice(0, i + 1).join(" "); }, i * 150)); }, at);
  setTimeout(() => { document.getElementById("cc").dataset.on = "1"; }, 0);
  say("Ann", "welcome everyone to the weekly sync", 300);
  say("Bob", "Maya what is the status of the release", 2500);
}
landing();
</script></body></html>`;

const chrome = findChrome("");
describe.skipIf(!chrome)("a real Chrome on a page shaped like Teams", () => {
  it("gets in as a guest with the camera off, announces itself, hears the captions, answers by chat, and leaves", async () => {
    const page = new ChromeMeetingPage({ chrome: chrome!, tmpRoot: mkdtempSync(join(tmpdir(), "friend-mtg-")), anyHost: true });
    const status: MeetingStatus[] = [];
    const lines: Line[] = [];
    const addressed: Line[] = [];
    const problems: string[] = [];
    const session = new MeetingSession({
      page,
      url: "data:text/html;base64," + Buffer.from(FIXTURE).toString("base64"),
      selfName: "Maya (assistant)",
      names: () => ["Maya"],
      prefs: () => DEFAULT_PREFS,
      announcement: "Hi, I am Maya, taking notes.",
      pollMs: 250,
      settleMs: 1200,
      replyDelayMs: 500,
      events: { status: (s) => status.push(s), lines: (l) => lines.push(...l), addressed: (l) => addressed.push(l), ownerRelevant() {}, notesDue() {}, problem: (p) => problems.push(p), ended() {} },
    });
    const done = session.start();
    const until = async (c: () => boolean, ms = 30_000) => {
      for (let t = 0; t < ms && !c(); t += 100) await new Promise((r) => setTimeout(r, 100));
      if (!c()) throw new Error(`timed out; status ${status.join(",")}; lines ${JSON.stringify(lines)}; problems ${problems.join("|")}`);
    };
    await until(() => addressed.length === 1);
    expect(status).toEqual(["joining", "lobby", "live"]);
    expect(lines.map((l) => l.speaker)).toEqual(["Ann", "Bob"]);
    expect(lines[0]!.text).toBe("welcome everyone to the weekly sync");
    expect(addressed[0]!.speaker).toBe("Bob");
    const run = (e: string) => (page as unknown as { run<R>(e: string): Promise<R> }).run<unknown>(e);
    expect(await run("window.guest")).toBe("Maya (assistant)");
    expect(await run('document.querySelector("[data-tid=toggle-video]") === null')).toBe(true); // it left the pre-join page
    expect(await session.say("The release is on track.")).toBe(true);
    expect(await run("window.chatLog")).toEqual(["Hi, I am Maya, taking notes.", "The release is on track."]);
    await session.stop("test over");
    await done;
    expect(status.at(-1)).toBe("ended");
  }, 60_000);
});

describe.skipIf(!chrome)("the Meet and Zoom scripts in a real Chrome", () => {
  it("run on an ordinary page without errors and say it is still loading", async () => {
    const page = new ChromeMeetingPage({ chrome: chrome!, tmpRoot: mkdtempSync(join(tmpdir(), "friend-mtg-")), anyHost: true });
    await page.open("data:text/html,<body><p>hello</p></body>");
    for (const p of ["teams", "meet", "zoom"] as const) {
      (page as unknown as { dom: unknown }).dom = domFor(p);
      expect(await page.advance("Maya")).toMatchObject({ phase: "loading" });
      expect(await page.captions()).toBeNull();
      expect(await page.chat("hi")).toBe(false);
      await page.enableCaptions().catch((e) => { throw e; });
    }
    await page.close();
  }, 60_000);
});