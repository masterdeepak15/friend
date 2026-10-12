import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { FakeProvider } from "../provider/fake";
import type { YtRun } from "./resolve";
import { fakeSpawn } from "./testing/fakeProcess";
import type { VideoStatus } from "./types";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const j = { "content-type": "application/json" };
const OK: VideoStatus = { ytdlp: { found: true, version: "1", path: "yt-dlp" }, ffmpeg: { found: true, version: "7", path: "ffmpeg" }, mpv: { found: true, version: "0", path: "mpv" } };
const youtube = {
  id: "abc",
  title: "A clip",
  uploader: "Someone",
  duration: 60,
  webpage_url: "https://www.youtube.com/watch?v=abc",
  requested_formats: [
    { url: "https://rr1.googlevideo.com/v", vcodec: "avc1.1", acodec: "none", http_headers: {} },
    { url: "https://rr1.googlevideo.com/a", vcodec: "none", acodec: "mp4a.40.2", http_headers: {} },
  ],
};

type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let port = 0;
let cookie = "";
const base = () => `http://127.0.0.1:${port}`;
let proc = fakeSpawn();

async function boot(on = true) {
  proc = fakeSpawn();
  const run: YtRun = async () => ({ code: 0, out: JSON.stringify(youtube), err: "" });
  app = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "friend-videoroute-")),
    provider: new FakeProvider([]),
    config: { port: 0, roots: [] },
    video: { run, spawn: proc.spawn as never, status: async () => OK, resolve: async () => ["93.184.216.34"] },
  });
  if (on) Object.assign(app.config.video, { installed: true, enabled: true });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
afterEach(async () => {
  await app?.stop();
});
const idOf = async (): Promise<string> => {
  const r = await app.video.play({ url: "https://www.youtube.com/watch?v=abc" });
  if (!r.ok || !r.show) throw new Error(`play failed: ${JSON.stringify(r)}`);
  return /\/api\/video\/([0-9a-f]{32})$/.exec(r.show.props.src)![1]!;
};

describe("the video address", () => {
  it("is only for the signed-in owner, and knows only addresses Friend made", async () => {
    await boot();
    const id = await idOf();
    expect((await fetch(`${base()}/api/video/${id}`)).status).toBe(401);
    expect((await fetch(`${base()}/api/video/${"0".repeat(32)}`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base()}/api/video/not-an-id`, { headers: { cookie } })).status).toBe(404);
    expect(proc.calls).toEqual([]);
  });

  it("sends the video as it is made: MP4, no byte ranges, never kept by the browser", async () => {
    await boot();
    const id = await idOf();
    const pending = fetch(`${base()}/api/video/${id}`, { headers: { cookie, range: "bytes=0-" } });
    for (let i = 0; i < 100 && proc.children.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(proc.children).toHaveLength(1);
    proc.children[0]!.finish(0);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("video/mp4");
    expect(res.headers.get("accept-ranges")).toBe("none");
    expect(res.headers.get("cache-control")).toMatch(/no-store/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await res.text()).toBe("FMP4DATA");
  });

  it("ends ffmpeg when the screen stops watching", async () => {
    await boot();
    const id = await idOf();
    const ctl = new AbortController();
    const res = await fetch(`${base()}/api/video/${id}`, { headers: { cookie }, signal: ctl.signal });
    const reader = res.body!.getReader();
    expect((await reader.read()).done).toBe(false); // the first bytes arrived
    ctl.abort();
    for (let i = 0; i < 100 && !proc.children[0]!.killed; i++) await new Promise((r) => setTimeout(r, 20));
    expect(proc.children[0]!.killed).toBe(true);
  });

  it("is gone once the plugin is switched off, even for an address made a moment ago", async () => {
    await boot();
    const id = await idOf();
    app.config.video.enabled = false;
    expect((await fetch(`${base()}/api/video/${id}`, { headers: { cookie } })).status).toBe(404);
    expect(proc.calls).toEqual([]);
  });

  it("says in words when ffmpeg is not there", async () => {
    await boot();
    const id = await idOf();
    proc.failToStart = true;
    const res = await fetch(`${base()}/api/video/${id}`, { headers: { cookie } });
    expect(res.status).toBe(502);
    expect(JSON.stringify(await res.json())).toMatch(/could not start ffmpeg/i);
  });
});
