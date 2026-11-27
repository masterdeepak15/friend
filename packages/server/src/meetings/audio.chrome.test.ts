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
  return page as unknown as Pick<ChromeMeetingPage, "speak" | "audio" | "mic"> & { run<R>(e: string): Promise<R> };
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
});