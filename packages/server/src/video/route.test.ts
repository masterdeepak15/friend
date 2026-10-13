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

let openedUrls: string[] = [];
let provisionCalls: string[][] = [];
async function boot(on = true, over: { status?: VideoStatus } = {}) {
  proc = fakeSpawn();
  openedUrls = [];
  provisionCalls = [];
  const run: YtRun = async () => ({ code: 0, out: JSON.stringify(youtube), err: "" });
  app = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "friend-videoroute-")),
    provider: new FakeProvider([]),
    config: { port: 0, roots: [] },
    video: {
      run,
      spawn: proc.spawn as never,
      status: async () => over.status ?? OK,
      resolve: async () => ["93.184.216.34"],
      openBrowser: async (url) => {
        openedUrls.push(url);
        return true;
      },
      provisioner: {
        ensure: async (names) => {
          provisionCalls.push([...names]);
          return { ok: true };
        },
        state: () => ({ busy: false, tools: {} }),
      },
    },
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
  return /\/api\/video\/([0-9a-f]{32})$/.exec(r.show.props.src!)![1]!;
};

describe("the plugin page's questions", () => {
  it("tell the owner which helper programs are found, and look again on request", async () => {
    await boot();
    expect((await fetch(base() + "/api/plugins/video/status")).status).toBe(401);
    expect((await fetch(base() + "/api/plugins/video/check", { method: "POST", headers: j, body: "{}" })).status).toBe(401);
    const st = await fetch(base() + "/api/plugins/video/status", { headers: { cookie } });
    expect(st.status).toBe(200);
    expect(await st.json()).toMatchObject({ ytdlp: { found: true, version: "1" }, ffmpeg: { found: true }, mpv: { found: true } });
    const ck = await fetch(base() + "/api/plugins/video/check", { method: "POST", headers: { ...j, cookie }, body: "{}" });
    expect(ck.status).toBe(200);
    expect(await ck.json()).toMatchObject({ ytdlp: { found: true } });
  });
});

describe("a browser window on the PC", () => {
  const NO_MPV: VideoStatus = { ...OK, mpv: { found: false, install: "mpv is not installed." } };
  const ticketUrl = async (): Promise<URL> => {
    Object.assign(app.config.video, { output: "host" });
    const r = await app.video.play({ url: "https://www.youtube.com/watch?v=abc" });
    if (!r.ok) throw new Error(`play failed: ${JSON.stringify(r)}`);
    return new URL(openedUrls[0]!);
  };

  it("opens Friend's own address with a ticket, which plays without signing in on this PC", async () => {
    await boot(true, { status: NO_MPV });
    const u = await ticketUrl();
    expect(u.pathname).toMatch(/^\/api\/video\/[0-9a-f]{32}$/);
    expect(u.hostname).toBe("127.0.0.1");
    expect(u.searchParams.get("o")).toMatch(/^[0-9a-f]{32}$/);
    const pending = fetch(`${base()}${u.pathname}${u.search}`); // no cookie: this is the PC's own browser
    for (let i = 0; i < 100 && proc.children.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    proc.children[0]!.finish(0);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("FMP4DATA");
  });

  it("turns away a wrong ticket, a ticket for another video, and no ticket at all", async () => {
    await boot(true, { status: NO_MPV });
    const u = await ticketUrl();
    expect((await fetch(`${base()}${u.pathname}?o=${"0".repeat(32)}`)).status).toBe(401);
    expect((await fetch(`${base()}/api/video/${"1".repeat(32)}?o=${u.searchParams.get("o")}`)).status).toBe(401);
    expect((await fetch(`${base()}${u.pathname}`)).status).toBe(401);
    expect((await fetch(`${base()}${u.pathname}?o=not-a-ticket`)).status).toBe(401);
    expect(proc.calls).toEqual([]);
  });
});

describe("the owner's \"set it up\" button", () => {
  it("downloads the programs by itself, for the signed-in owner only", async () => {
    await boot();
    expect((await fetch(base() + "/api/plugins/video/prepare", { method: "POST", headers: j, body: "{}" })).status).toBe(401);
    const r = await fetch(base() + "/api/plugins/video/prepare", { method: "POST", headers: { ...j, cookie }, body: "{}" });
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ytdlp: { found: true } });
  });
  it("is done when the plugin is installed or switched on, without anyone pressing it", async () => {
    await boot(false, { status: { ...OK, ytdlp: { found: false }, ffmpeg: { found: false } } });
    const post = (path: string, body: unknown) => fetch(base() + path, { method: "POST", headers: { ...j, cookie }, body: JSON.stringify(body) });
    expect((await post("/api/plugins/install", { id: "video", pin: owner.pin })).status).toBe(200);
    for (let i = 0; i < 100 && provisionCalls.length === 0; i++) await new Promise((r) => setTimeout(r, 20));
    expect(provisionCalls[0]).toEqual(["yt-dlp", "ffmpeg"]);
  });
  it("does not download when the owner turned automatic download off", async () => {
    await boot(false, { status: { ...OK, ytdlp: { found: false }, ffmpeg: { found: false } } });
    app.config.video.autoInstall = false;
    const post = (path: string, body: unknown) => fetch(base() + path, { method: "POST", headers: { ...j, cookie }, body: JSON.stringify(body) });
    await post("/api/plugins/install", { id: "video", pin: owner.pin });
    await new Promise((r) => setTimeout(r, 300));
    expect(provisionCalls).toEqual([]);
  });
});

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
