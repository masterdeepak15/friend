import { createServer, type Server } from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findChrome } from "../browser/chrome";
import { ChromeMeetingPage } from "./chromePage";
import { pcmToWav } from "./speech";

const chrome = findChrome("");
let server: Server | undefined;
let page: ChromeMeetingPage | undefined;
afterEach(async () => {
  await page?.close();
  page = undefined;
  await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
  server = undefined;
});

/** Serves a page on localhost (a secure place, where a page may ask for a microphone). */
async function serve(html: string): Promise<string> {
  server = createServer((_, res) => res.writeHead(200, { "content-type": "text/html" }).end(html));
  await new Promise<void>((r) => server!.listen(0, "127.0.0.1", r));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
}

const until = async (cond: () => Promise<boolean>, ms = 15_000) => {
  for (let t = 0; t < ms; t += 200) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("timed out");
};

const tone = (seconds: number, rate = 22050, hz = 440): Buffer => {
  const n = Math.floor(seconds * rate);
  const b = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) b.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 12000), i * 2);
  return pcmToWav(b, rate);
};

const open = async (html: string) => {
  page = new ChromeMeetingPage({ chrome: chrome!, tmpRoot: mkdtempSync(join(tmpdir(), "friend-aud-")), anyHost: true });
  await page.open(await serve(html));
  const ready = page as unknown as { run<R>(e: string): Promise<R> };
  await until(async () => (await ready.run<string>("document.readyState").catch(() => "")) === "complete");
  return page as unknown as Pick<ChromeMeetingPage, "speak" | "audio" | "mic" | "camera" | "enableCaptions" | "captions" | "chat"> & { dom: unknown } & { run<R>(e: string): Promise<R> };
};

describe.skipIf(!chrome)("sound in a real Chrome, with no driver on the PC", () => {
  it("what the assistant says reaches the microphone the site asked for, and the microphone is silent otherwise", async () => {
    const p = await open(`<!doctype html><body><script>
window.peak = 0; window.ready = false;
navigator.mediaDevices.getUserMedia({ audio: true, video: true }).then((s) => {
  window.tracks = s.getAudioTracks().length;
  const ctx = new AudioContext(); const an = ctx.createAnalyser(); an.fftSize = 1024;
  ctx.createMediaStreamSource(s).connect(an);
  const buf = new Float32Array(an.fftSize);
  setInterval(() => { an.getFloatTimeDomainData(buf); let m = 0; for (const v of buf) m = Math.max(m, Math.abs(v)); window.peak = Math.max(window.peak, m); }, 20);
  window.ready = true;
});
</script></body>`);
    await until(async () => (await p.run<boolean>("window.ready")) === true);
    expect(await p.run<number>("window.tracks")).toBe(1);
    await new Promise((r) => setTimeout(r, 600));
    expect(await p.run<number>("window.peak")).toBeLessThan(0.001); // nothing is sent until it speaks
    expect(await p.speak(tone(1))).toBe(true);
    expect(await p.run<number>("window.peak")).toBeGreaterThan(0.05);
  }, 60_000);

  it("hears the other people of a call (their audio tracks) as 16 kHz sound, and nothing when nobody is on the call", async () => {
    const p = await open(`<!doctype html><body><script>
(async () => {
  const ctx = new AudioContext(); const osc = ctx.createOscillator(); osc.frequency.value = 440; const dst = ctx.createMediaStreamDestination(); osc.connect(dst); osc.start();
  const a = new RTCPeerConnection(), b = new RTCPeerConnection();
  a.onicecandidate = (e) => e.candidate && b.addIceCandidate(e.candidate);
  b.onicecandidate = (e) => e.candidate && a.addIceCandidate(e.candidate);
  window.remote = 0; b.ontrack = () => { window.remote++; };
  dst.stream.getAudioTracks().forEach((t) => a.addTrack(t, dst.stream));
  await a.setLocalDescription(await a.createOffer()); await b.setRemoteDescription(a.localDescription);
  await b.setLocalDescription(await b.createAnswer()); await a.setRemoteDescription(b.localDescription);
})();
</script></body>`);
    expect(await p.audio()).toEqual(Buffer.alloc(0)); // nobody on a call yet
    await until(async () => (await p.run<number>("window.remote || 0")) > 0);
    await new Promise((r) => setTimeout(r, 1500));
    const pcm = (await p.audio())!;
    expect(pcm.length).toBeGreaterThan(16000); // more than a quarter of a second of 16 kHz sound
    let peak = 0;
    for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)));
    expect(peak).toBeGreaterThan(3000);
  }, 60_000);

  it("puts the meeting microphone button the way it is wanted, whatever way the site words it, and leaves camera buttons alone", async () => {
    for (const [live, muted] of [["Mute mic", "Unmute mic"], ["Turn off microphone", "Turn on microphone"], ["Mute my microphone", "Unmute my microphone"]] as const) {
      const p = await open(`<!doctype html><body><button id="cam" aria-label="Turn off camera">cam</button><button id="mic" aria-label="${muted}">mic</button><script>
window.clicks = 0; const mic = document.getElementById("mic"); let on = false;
mic.onclick = () => { on = !on; window.clicks++; mic.setAttribute("aria-label", on ? ${JSON.stringify(live)} : ${JSON.stringify(muted)}); };
document.getElementById("cam").onclick = () => { window.camClicked = true; };
</script></body>`);
      expect(await p.mic(false)).toBe(true); // already muted: not clicked
      expect(await p.run<number>("window.clicks")).toBe(0);
      expect(await p.mic(true)).toBe(true);
      expect(await p.run<string>('document.getElementById("mic").getAttribute("aria-label")')).toBe(live);
      expect(await p.mic(true)).toBe(true); // already live: not clicked again
      expect(await p.run<number>("window.clicks")).toBe(1);
      expect(await p.mic(false)).toBe(true);
      expect(await p.run<string>('document.getElementById("mic").getAttribute("aria-label")')).toBe(muted);
      expect(await p.run<boolean>("!!window.camClicked")).toBe(false);
      await page?.close();
      page = undefined;
    }
    const p = await open("<!doctype html><body><p>no call here</p></body>");
    expect(await p.mic(true)).toBe(false);
  }, 90_000);

  it("shows a picture of its own as the camera, and it moves", async () => {
    const p = await open(`<!doctype html><body><video id="v" autoplay muted playsinline></video><canvas id="c" width="64" height="36"></canvas><script>
window.frames = [];
navigator.mediaDevices.getUserMedia({ video: true }).then((s) => {
  window.vtracks = s.getVideoTracks().length;
  const v = document.getElementById("v"); v.srcObject = s; v.play();
  const c = document.getElementById("c").getContext("2d");
  setInterval(() => { if (!v.videoWidth) return; window.w = v.videoWidth; c.drawImage(v, 0, 0, 64, 36); const d = c.getImageData(0, 0, 64, 36).data; let h = 0; for (let i = 0; i < d.length; i += 4) h = (h * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7) | 0; window.frames.push(h); }, 150);
});
</script></body>`);
    await until(async () => (await p.run<number>("window.w || 0")) > 0);
    expect(await p.run<number>("window.vtracks")).toBe(1);
    expect(await p.run<number>("window.w")).toBe(640);
    await new Promise((r) => setTimeout(r, 1800));
    const frames = await p.run<number[]>("window.frames");
    expect(new Set(frames).size).toBeGreaterThan(2); // not a still picture
    // while it speaks, the picture is different from the quiet one
    const quietNow = frames.at(-1);
    void p.speak(tone(1.5));
    await new Promise((r) => setTimeout(r, 700));
    const during = await p.run<number[]>("window.frames.slice(-4)");
    expect(during.every((h) => h !== quietNow)).toBe(true);
  }, 60_000);

  it("puts the camera button the way it is wanted", async () => {
    const p = await open(`<!doctype html><body><button id="cam" aria-label="Turn camera off">Camera</button><button id="fx" aria-label="Video effects and settings">fx</button><script>
window.fx = 0; const cam = document.getElementById("cam"); let on = true;
cam.onclick = () => { on = !on; cam.setAttribute("aria-label", on ? "Turn camera off" : "Turn camera on"); };
document.getElementById("fx").onclick = () => { window.fx++; };
</script></body>`);
    expect(await p.camera(true)).toBe(true); // already on: left alone
    expect(await p.run<string>('document.getElementById("cam").getAttribute("aria-label")')).toBe("Turn camera off");
    expect(await p.camera(false)).toBe(true);
    expect(await p.run<string>('document.getElementById("cam").getAttribute("aria-label")')).toBe("Turn camera on");
    expect(await p.camera(true)).toBe(true);
    expect(await p.run<string>('document.getElementById("cam").getAttribute("aria-label")')).toBe("Turn camera off");
    expect(await p.run<number>("window.fx")).toBe(0);
  }, 60_000);

  it("turns on the captions of the Teams page of today: the more menu that opens only for a real mouse, an item called Captions, and not again once they are on", async () => {
    const p = await open(`<!doctype html><body><button id="callingButtons-showMoreBtn" aria-label="More">More</button><div id="menu"></div><div id="cc"></div><script>
window.toggles = 0; let open = false; let on = false;
const more = document.getElementById("callingButtons-showMoreBtn");
// like Teams: a plain click() from a script does nothing, a real press does
more.addEventListener("mousedown", () => { open = !open; render(); });
function render() {
  const m = document.getElementById("menu");
  m.innerHTML = open ? '<div role="menu"><div role="menuitem" id="meeting-info-button" aria-label="Meeting info">Meeting info</div><div role="menuitem" id="closed-captions-button" aria-label="Captions" aria-checked="' + on + '" title="Show live captions">Captions</div></div>' : "";
  const item = document.getElementById("closed-captions-button");
  if (item) item.onclick = () => { on = !on; window.toggles++; open = false; render(); document.getElementById("cc").innerHTML = on ? '<div data-tid="closed-caption-renderer-wrapper"><div data-tid="closed-caption-v2-virtual-list-content"></div></div>' : ""; };
}
</script></body>`);
    expect(await p.captions()).toBeNull();
    await p.enableCaptions();
    expect(await p.captions()).toEqual([]); // the panel is there, nobody has spoken
    expect(await p.run<number>("window.toggles")).toBe(1);
    await p.enableCaptions(); // asked again while they are on: they are not switched off
    expect(await p.run<number>("window.toggles")).toBe(1);
    expect(await p.captions()).toEqual([]);
  }, 60_000);

  it("sends a chat message with the site's own send button when Enter does not send it", async () => {
    const p = await open(`<!doctype html><body><div data-tid="chat-button" id="chat-button">Chat</div><div id="chat" style="display:none"><div role="textbox" contenteditable="true" data-tid="ckeditor" style="min-height:20px;border:1px solid"></div><button data-tid="newMessageCommands-send" aria-label="Send">Send</button></div><script>
window.log = [];
document.getElementById("chat-button").onclick = () => { document.getElementById("chat").style.display = "block"; };
// Enter inserts a line break and sends nothing, like a box that wants the button
document.querySelector("[data-tid=newMessageCommands-send]").onclick = () => { const b = document.querySelector("[data-tid=ckeditor]"); if (b.innerText.trim()) { window.log.push(b.innerText.trim()); b.innerText = ""; } };
</script></body>`);
    expect(await p.chat("Hello, I am Maya.")).toBe(true);
    expect(await p.run<string[]>("window.log")).toEqual(["Hello, I am Maya."]);
  }, 60_000);
});