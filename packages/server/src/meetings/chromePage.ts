import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Cdp } from "../browser/cdp";
import { endpoint, removeProfile, shutdown } from "../browser/hub";
import type { CaptionItem } from "./logic";
import type { MeetingPage, Phase } from "./session";
import { domFor } from "./dom";
import type { DomSet } from "./domKit";
import { meetingPlatform } from "./logic";
import { audioHook } from "./audioHook";
import { camTo, micTo } from "./domKit";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export interface ChromePageOptions {
  chrome: string;
  /** Where the throwaway profile is made (Friend's own folder, so leftovers can be swept). */
  tmpRoot?: string;
  /** Tests point the page at a local fixture instead of Teams. */
  headless?: boolean;
  /** Tests only: do not insist the page is a Microsoft one. */
  anyHost?: boolean;
}

/**
 * One meeting in a Chrome of its own: a fresh private profile with nothing in it (no sign-ins, no cookies), a fake camera and
 * microphone that are never switched on, and nothing kept afterwards. The profile is deleted when the meeting is left.
 */
export class ChromeMeetingPage implements MeetingPage {
  private child: ChildProcess | null = null;
  private cdp: Cdp | null = null;
  private sessionId = "";
  private profile = "";
  private tries = 0;
  private dom: DomSet = domFor("teams");

  constructor(private o: ChromePageOptions) {}

  async open(url: string, name = "Assistant"): Promise<void> {
    this.dom = domFor(meetingPlatform(url) ?? "teams");
    const root = this.o.tmpRoot ?? tmpdir();
    mkdirSync(root, { recursive: true });
    this.profile = mkdtempSync(join(root, "friend-meeting-"));
    this.child = spawn(
      this.o.chrome,
      [
        ...(this.o.headless === false ? [] : ["--headless=new"]),
        `--user-data-dir=${this.profile}`,
        "--remote-debugging-port=0",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-extensions",
        "--disable-sync",
        "--disable-component-update",
        "--disable-default-apps",
        "--disable-breakpad",
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        "--autoplay-policy=no-user-gesture-required",
        "--mute-audio",
        "--lang=en-US",
        "--window-size=1366,900",
        "about:blank",
      ],
      { stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" },
    );
    this.child.on("error", () => {});
    const ac = AbortSignal.timeout(30_000);
    this.cdp = await Cdp.connect(await endpoint(this.profile, ac));
    const c = this.cdp;
    const { targetId } = await c.send<{ targetId: string }>("Target.createTarget", { url: "about:blank" });
    const { sessionId } = await c.send<{ sessionId: string }>("Target.attachToTarget", { targetId, flatten: true });
    this.sessionId = sessionId;
    c.on((method, p, sid) => {
      // a pop-up window or a download is never wanted
      if (method === "Target.targetCreated" && p.targetInfo?.targetId !== targetId && p.targetInfo?.type === "page") void c.send("Target.closeTarget", { targetId: p.targetInfo.targetId }).catch(() => {});
      if (sid === sessionId && method === "Page.javascriptDialogOpening") void c.send("Page.handleJavaScriptDialog", { accept: false }, sessionId).catch(() => {});
    });
    await c.send("Target.setDiscoverTargets", { discover: true });
    await c.send("Browser.setDownloadBehavior", { behavior: "deny" }).catch(() => {});
    await this.send("Page.enable");
    // a microphone that is ours and ears on the call, in every page, before the site runs
    await this.send("Page.addScriptToEvaluateOnNewDocument", { source: audioHook(name) });
    // a headless Chrome names itself so; Teams does not like that
    const v = await c.send<{ userAgent?: string }>("Browser.getVersion").catch(() => ({}) as { userAgent?: string });
    if (v.userAgent) await this.send("Emulation.setUserAgentOverride", { userAgent: v.userAgent.replace("HeadlessChrome", "Chrome"), acceptLanguage: "en-US,en" });
    await this.send("Emulation.setDeviceMetricsOverride", { width: 1366, height: 900, deviceScaleFactor: 1, mobile: false });
    await this.send("Page.navigate", { url });
  }

  private send<R = Record<string, any>>(method: string, params: Record<string, unknown> = {}): Promise<R> {
    if (!this.cdp) return Promise.reject(new Error("The browser is not open."));
    return this.cdp.send<R>(method, params, this.sessionId);
  }

  private async run<R>(expression: string): Promise<R> {
    const r = await this.send<{ result?: { value?: R }; exceptionDetails?: unknown }>("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error("The page could not be read.");
    return r.result?.value as R;
  }

  async advance(name: string): Promise<{ phase: Phase; detail: string }> {
    return (await this.run<{ phase: Phase; detail: string }>(this.dom.advance(name, !!this.o.anyHost)).catch(() => ({ phase: "loading" as Phase, detail: "The page is loading." }))) ?? { phase: "loading", detail: "" };
  }

  async captions(): Promise<CaptionItem[] | null> {
    const r = await this.run<{ on: boolean; items: CaptionItem[] }>(this.dom.captions).catch(() => null);
    return r && r.on ? r.items : null;
  }

  async enableCaptions(): Promise<void> {
    this.tries++;
    const k = this.dom.shortcut;
    if (k && this.tries % 2 === 0) {
      // the site's own keyboard shortcut switches live captions on or off
      for (const type of ["rawKeyDown", "keyUp"]) await this.send("Input.dispatchKeyEvent", { type, modifiers: k.modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.vk });
      await sleep(800);
      return;
    }
    // the menu way: each step finds its button, and the last may be a question asked the first time (which language is spoken)
    // (only the first step must be found: the menus differ from one version of the site to the next, and the later steps are tried in turn)
    for (const [i, step] of this.dom.captionSteps.entries()) {
      const found = await this.run<boolean | { x: number; y: number }>(step).catch(() => false);
      if (!found && i === 0) return;
      // some buttons open their menu only for a real mouse click
      if (found && typeof found === "object") await this.mouseClick(found.x, found.y);
      await sleep(i < 2 ? 900 : 800);
    }
  }

  private async mouseClick(x: number, y: number): Promise<void> {
    for (const type of ["mouseMoved", "mousePressed", "mouseReleased"]) await this.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1, buttons: type === "mouseReleased" ? 0 : 1 });
  }

  async chat(text: string): Promise<boolean> {
    try {
      if (!(await this.run<boolean>(this.dom.focusChat))) return false;
      await this.send("Input.insertText", { text: text.slice(0, 600) });
      await sleep(200);
      await this.send("Input.dispatchKeyEvent", { type: "keyDown", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13, text: "\r" });
      await this.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Enter", code: "Enter", windowsVirtualKeyCode: 13 });
      await sleep(400);
      // if Enter did not send it, the send button of the site does
      const sent = await this.run<boolean | { x: number; y: number }>(this.dom.sendChat).catch(() => true);
      if (sent && typeof sent === "object") {
        await this.mouseClick(sent.x, sent.y);
        await sleep(400);
      }
      return sent !== false;
    } catch {
      return false;
    }
  }

  /** Switches the meeting camera (the picture of the assistant) on or off; false when the button was not found. */
  async camera(on: boolean): Promise<boolean> {
    return (await this.run<boolean>(camTo(on)).catch(() => false)) === true;
  }

  /** Switches the meeting microphone on or off; false when the button was not found. */
  async mic(on: boolean): Promise<boolean> {
    return (await this.run<boolean>(micTo(on)).catch(() => false)) === true;
  }

  /** Plays a spoken WAV into the meeting microphone and returns when it has finished. */
  async speak(wav: Buffer): Promise<boolean> {
    try {
      const secs = await this.run<number>(`window.__friend ? window.__friend.speak(${JSON.stringify(wav.toString("base64"))}) : 0`);
      return typeof secs === "number" && secs > 0;
    } catch {
      return false;
    }
  }

  /** The sound of the other people since the last call, as 16 kHz 16-bit mono; null when the page has no call yet. */
  async audio(): Promise<Buffer | null> {
    const b64 = await this.run<string | null>("window.__friend && window.__friend.take ? window.__friend.take() : null").catch(() => null);
    return typeof b64 === "string" ? Buffer.from(b64, "base64") : null;
  }

  async leave(): Promise<void> {
    await this.run<boolean>(this.dom.hangUp).catch(() => false);
    await sleep(500);
  }

  async close(): Promise<void> {
    this.cdp?.close();
    this.cdp = null;
    await shutdown(this.child);
    this.child = null;
    if (this.profile) await removeProfile(this.profile);
    this.profile = "";
  }
}
