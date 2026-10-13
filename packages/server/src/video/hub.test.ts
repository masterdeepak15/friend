import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { VideoHub, type VideoHostLike } from "./hub";
import type { YtRun } from "./resolve";
import { managedPath } from "./provision";
import { fakeSpawn } from "./testing/fakeProcess";
import type { VideoStatus } from "./types";

const found = (path: string, version = "1"): { found: true; path: string; version: string } => ({ found: true, path, version });
const OK: VideoStatus = { ytdlp: found("/bin/yt-dlp", "2026.10.01"), ffmpeg: found("/bin/ffmpeg", "7.1"), mpv: found("/bin/mpv", "0.39") };

const youtube = {
  id: "dQw4w9WgXcQ",
  title: "Never Gonna Give You Up",
  uploader: "Rick Astley",
  duration: 213,
  webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  requested_formats: [
    { url: "https://rr3---sn-abc.googlevideo.com/videoplayback?id=v", vcodec: "avc1.64001f", acodec: "none", protocol: "https", http_headers: { "User-Agent": "UA" } },
    { url: "https://rr3---sn-abc.googlevideo.com/videoplayback?id=a", vcodec: "none", acodec: "mp4a.40.2", protocol: "https", http_headers: {} },
  ],
};

function fakeHost(over: { openError?: string } = {}): VideoHostLike & { calls: unknown[][] } {
  const calls: unknown[][] = [];
  return {
    calls,
    open: async (url, o) => {
      calls.push(["open", url, o]);
      return over.openError ? { ok: false, error: over.openError } : { ok: true };
    },
    pause: async (on) => void calls.push(["pause", on]),
    seek: async (s) => void calls.push(["seek", s]),
    volume: async (p) => void calls.push(["volume", p]),
    stop: async () => void calls.push(["stop"]),
  };
}

/** A stand-in for the downloader: it fills in what is missing after a moment, or never, or fails. */
function fakeProvisioner(over: { onEnsure?: () => Promise<{ ok: true } | { ok: false; error: string }>; busy?: boolean } = {}) {
  const calls: string[][] = [];
  return {
    calls,
    ensure: async (names: string[]) => {
      calls.push([...names]);
      return over.onEnsure ? over.onEnsure() : ({ ok: true } as const);
    },
    state: () => ({ busy: over.busy ?? false, tools: {} as Record<string, { phase: string; percent?: number | null; error?: string }> }),
  };
}

let defaultMode = "stream";
function make(over: { fetch?: typeof fetch; video?: Record<string, unknown>; status?: VideoStatus; json?: unknown; host?: VideoHostLike; provisioner?: ReturnType<typeof fakeProvisioner>; statuses?: VideoStatus[]; browser?: boolean; browserWorks?: boolean } = {}) {
  const opened: string[] = [];
  const ytCalls: string[][] = [];
  const run: YtRun = async (_cmd, args) => {
    ytCalls.push(args);
    return { code: 0, out: JSON.stringify(over.json ?? youtube), err: "" };
  };
  const proc = fakeSpawn();
  let now = 1_000_000;
  let statusCalls = 0;
  const cfg = { video: { installed: true, enabled: true, output: "screen", maxHeight: 720, maxMinutes: 240, allowedSites: [], ytdlp: "", ffmpeg: "", autoInstall: true, youtube: defaultMode, ...over.video }, music: { hostPlayer: "" } };
  const hub = new VideoHub({
    config: () => cfg as never,
    run,
    spawn: proc.spawn as never,
    resolve: async () => ["93.184.216.34"],
    status: async () => {
      statusCalls++;
      return over.statuses ? over.statuses[Math.min(statusCalls - 1, over.statuses.length - 1)]! : (over.status ?? OK);
    },
    provisioner: over.provisioner as never,
    waitMs: 20,
    fetch: over.fetch ?? (async () => new Response(JSON.stringify({ title: "Never Gonna Give You Up", author_name: "Rick Astley" }))) as unknown as typeof fetch,
    ...(over.browser
      ? {
          windowUrl: (id: string, nonce: string) => `http://127.0.0.1:8787/api/video/${id}?o=${nonce}`,
          openBrowser: async (url: string) => {
            opened.push(url);
            return over.browserWorks !== false;
          },
        }
      : {}),
    host: over.host,
    clock: () => now,
  });
  return { hub, ytCalls, proc, opened, advance: (ms: number) => (now += ms), statusCalls: () => statusCalls, cfg };
}
const URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const srcId = (src: string) => /^\/api\/video\/([0-9a-f]{32})$/.exec(src)![1]!;

describe("a YouTube video on the Friend screen: YouTube's own player, nothing to download", () => {
  beforeEach(() => { defaultMode = "embed"; });
  afterEach(() => { defaultMode = "stream"; });
  const YT_URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
  const NOTHING: VideoStatus = { ytdlp: { found: false, install: "yt-dlp is not installed." }, ffmpeg: { found: false, install: "ffmpeg is not installed." }, mpv: { found: false } };

  it("shows the player by the video's id, with the title YouTube gives, and uses no program at all for a link", async () => {
    const prov = fakeProvisioner();
    const t = make({ status: NOTHING, provisioner: prov });
    const r = await t.hub.play({ url: YT_URL });
    expect(r).toEqual({ ok: true, text: 'Playing "Never Gonna Give You Up" by Rick Astley on your Friend screen.', show: { id: "video-now", props: { title: "Never Gonna Give You Up", embed: "dQw4w9WgXcQ" } } });
    expect(t.ytCalls).toEqual([]);
    expect(t.proc.calls).toEqual([]);
    expect(prov.calls).toEqual([]);
  });

  it("starts where the owner asked", async () => {
    const r = await make().hub.play({ url: YT_URL, start: 95 });
    expect(r).toMatchObject({ ok: true, show: { props: { embed: "dQw4w9WgXcQ", start: 95 } } });
  });

  it("searches with yt-dlp for words, but only for the list of results, and plays the first in the player", async () => {
    const t = make({ json: { entries: [{ id: "dQw4w9WgXcQ", title: "Never Gonna Give You Up", uploader: "Rick Astley" }] } });
    const r = await t.hub.play({ query: "never gonna give you up" });
    expect(r).toMatchObject({ ok: true, show: { props: { embed: "dQw4w9WgXcQ", title: "Never Gonna Give You Up" } } });
    expect(t.ytCalls[0]).toContain("--flat-playlist");
    expect(t.proc.calls).toEqual([]);
  });

  it("downloads only yt-dlp for a search, and nothing for a link", async () => {
    const prov = fakeProvisioner();
    const t = make({ statuses: [NOTHING, { ...OK, ffmpeg: { found: false } }], provisioner: prov, json: { entries: [{ id: "dQw4w9WgXcQ", title: "T" }] } });
    await t.hub.play({ query: "x" });
    expect(prov.calls).toEqual([["yt-dlp"]]);
  });

  it("uses the stream through Friend (ffmpeg) when asked for it, by the request or by the owner's setting", async () => {
    const a = make();
    const r = await a.hub.play({ url: YT_URL, mode: "stream" });
    expect(r).toMatchObject({ ok: true, show: { props: { src: expect.stringMatching(/^\/api\/video\/[0-9a-f]{32}$/) } } });
    expect(a.ytCalls).toHaveLength(1);
    const b = make({ video: { youtube: "stream" } });
    expect(await b.hub.play({ url: YT_URL })).toMatchObject({ ok: true, show: { props: { src: expect.stringMatching(/^\/api\/video\/[0-9a-f]{32}$/) } } });
    const c = make({ video: { youtube: "stream" } });
    expect(await c.hub.play({ url: YT_URL, mode: "embed" })).toMatchObject({ ok: true, show: { props: { embed: "dQw4w9WgXcQ" } } });
  });

  it("leaves other sites and a window on the PC as they were", async () => {
    const other = make();
    expect(await other.hub.play({ url: "https://vimeo.com/12345" })).toMatchObject({ ok: true, show: { props: { src: expect.stringMatching(/\/api\/video\//) } } });
    const host = fakeHost();
    const t = make({ video: { output: "host" }, host });
    await t.hub.play({ url: YT_URL });
    expect(host.calls[0]![0]).toBe("open");
  });

  it("keeps the owner's list of sites and the address rule for a link", async () => {
    const t = make({ video: { allowedSites: ["vimeo.com"] } });
    expect(await t.hub.play({ url: YT_URL })).toEqual({ ok: false, text: expect.stringMatching(/allowed list/i) });
    expect(await t.hub.play({ query: "x" })).toEqual({ ok: false, text: expect.stringMatching(/search uses YouTube/i) });
  });

  it("says a live stream is playing, the same way", async () => {
    const t = make({ json: { entries: [{ id: "jfKfPfyJRdk", title: "lofi hip hop radio", uploader: "Lofi Girl", is_live: true }] } });
    expect(await t.hub.play({ query: "lofi hip hop radio" })).toMatchObject({ ok: true, show: { props: { embed: "jfKfPfyJRdk" } } });
  });

  it("stop takes the card away; seek starts the player again from that time; pause and volume point to its own buttons", async () => {
    const t = make();
    await t.hub.play({ url: YT_URL });
    expect(await t.hub.control({ action: "seek", seconds: 120 })).toMatchObject({ ok: true, show: { id: "video-now", props: { embed: "dQw4w9WgXcQ", start: 120 } } });
    for (const action of ["pause", "resume", "volume"] as const) expect(await t.hub.control({ action }), action).toEqual({ ok: true, text: expect.stringMatching(/own buttons/i) });
    expect(await t.hub.control({ action: "stop" })).toMatchObject({ ok: true, hide: "video-now" });
  });

  it("tells what is playing", async () => {
    const t = make();
    await t.hub.play({ url: YT_URL });
    expect(t.hub.nowPlaying()).toMatch(/Never Gonna Give You Up.*Friend screen/);
  });
});

describe("playing on the Friend screen", () => {
  it("finds the video, says what is playing, and gives the screen a Friend address for it (nothing is started yet)", async () => {
    const t = make();
    const r = await t.hub.play({ url: URL });
    expect(r).toMatchObject({ ok: true, text: 'Playing "Never Gonna Give You Up" by Rick Astley on your Friend screen.', show: { id: "video-now", props: { title: "Never Gonna Give You Up", src: expect.stringMatching(/^\/api\/video\/[0-9a-f]{32}$/) } } });
    expect(t.ytCalls).toHaveLength(1);
    expect(t.proc.calls).toEqual([]);
  });

  it("starts ffmpeg only when the screen asks for the video, with the owner's height and length limits", async () => {
    const t = make({ video: { maxHeight: 480, maxMinutes: 60 } });
    const r = await t.hub.play({ url: URL });
    if (!r.ok || !r.show) throw new Error("not ok");
    const h = await t.hub.streamOf(srcId(r.show.props.src!));
    expect(h).not.toBeNull();
    expect(t.proc.calls).toHaveLength(1);
    expect(t.proc.calls[0]!.cmd).toBe("/bin/ffmpeg");
    expect(t.proc.calls[0]!.args).toContain(String(60 * 60));
    h!.stop();
  });

  it("begins where the owner asked, and only for that request", async () => {
    const t = make();
    const r = await t.hub.play({ url: URL, start: 95 });
    if (!r.ok || !r.show) throw new Error("not ok");
    (await t.hub.streamOf(srcId(r.show.props.src!)))!.stop();
    const a = t.proc.calls[0]!.args;
    expect(a[a.indexOf("-ss") + 1]).toBe("95");
  });

  it("does not know an address it did not make, and forgets one after a while", async () => {
    const t = make();
    expect(await t.hub.streamOf("0".repeat(32))).toBeNull();
    expect(await t.hub.streamOf("../etc/passwd")).toBeNull();
    const r = await t.hub.play({ url: URL });
    if (!r.ok || !r.show) throw new Error("not ok");
    t.advance(7 * 3600 * 1000);
    expect(await t.hub.streamOf(srcId(r.show.props.src!))).toBeNull();
  });

  it("runs two streams at most: a third ends the oldest", async () => {
    const t = make();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await t.hub.play({ url: URL });
      if (!r.ok || !r.show) throw new Error("not ok");
      ids.push(srcId(r.show.props.src!));
    }
    for (const id of ids) await t.hub.streamOf(id);
    expect(t.proc.children).toHaveLength(3);
    expect(t.proc.children.map((c) => c.killed)).toEqual([true, false, false]);
  });

  it("searches when given words, and says nothing it was not asked", async () => {
    const t = make({ json: { entries: [youtube] } });
    const r = await t.hub.play({ query: "never gonna give you up" });
    expect(r.ok).toBe(true);
    expect(t.ytCalls[0]!.slice(-1)[0]).toBe("ytsearch1:never gonna give you up");
  });
});

describe("what stops a video from playing, said plainly", () => {
  it("is the plugin being off", async () => {
    for (const video of [{ installed: false }, { enabled: false }]) {
      const t = make({ video });
      const r = await t.hub.play({ url: URL });
      expect(r).toEqual({ ok: false, text: expect.stringMatching(/not switched on.*Plugins/i) });
      expect(t.ytCalls).toEqual([]);
    }
  });
  it("is a helper program that is missing, with the command for it", async () => {
    const miss = (h: string, extra: Record<string, unknown> = {}) => ({ ...OK, [h]: { found: false, install: `${h} is not installed. Install it with: winget install ${h}.` }, ...extra }) as VideoStatus;
    let r = await make({ status: miss("ytdlp") }).hub.play({ url: URL });
    expect(r).toEqual({ ok: false, text: expect.stringMatching(/winget install ytdlp/) });
    r = await make({ status: miss("ffmpeg") }).hub.play({ url: URL });
    expect(r).toEqual({ ok: false, text: expect.stringMatching(/winget install ffmpeg/) });
    r = await make({ status: miss("ffmpeg"), video: { output: "host" }, host: fakeHost() }).hub.play({ url: URL });
    expect(r.ok).toBe(true); // a window on the PC does not need ffmpeg
    r = await make({ status: miss("mpv"), video: { output: "host" }, host: fakeHost() }).hub.play({ url: URL });
    expect(r).toEqual({ ok: false, text: expect.stringMatching(/winget install mpv/) });
  });
  it("is a link that is not allowed, before anything runs", async () => {
    const t = make();
    const r = await t.hub.play({ url: "http://192.168.1.2/x" });
    expect(r).toEqual({ ok: false, text: expect.stringMatching(/this PC or your network/i) });
    expect(t.ytCalls).toEqual([]);
  });
  it("is asking for nothing", async () => {
    expect(await make().hub.play({})).toEqual({ ok: false, text: expect.stringMatching(/what to play/i) });
  });
  it("looks for the helpers once a minute, not for every video", async () => {
    const t = make();
    await t.hub.play({ url: URL });
    await t.hub.play({ url: URL });
    expect(t.statusCalls()).toBe(1);
    t.advance(61_000);
    await t.hub.play({ url: URL });
    expect(t.statusCalls()).toBe(2);
  });
});

describe("controlling a video on the screen", () => {
  it("stop closes the card and ends any stream", async () => {
    const t = make();
    const r = await t.hub.play({ url: URL });
    if (!r.ok || !r.show) throw new Error("not ok");
    await t.hub.streamOf(srcId(r.show.props.src!));
    const s = await t.hub.control({ action: "stop" });
    expect(s).toMatchObject({ ok: true, hide: "video-now" });
    expect(t.proc.children[0]!.killed).toBe(true);
    expect((await t.hub.control({ action: "stop" })).ok).toBe(true);
  });
  it("seek starts the video again from that time, on a new address", async () => {
    const t = make();
    const r = await t.hub.play({ url: URL });
    if (!r.ok || !r.show) throw new Error("not ok");
    const s = await t.hub.control({ action: "seek", seconds: 120 });
    if (!s.ok || !s.show) throw new Error("no new card");
    expect(s.show.props.src).not.toBe(r.show.props.src);
    (await t.hub.streamOf(srcId(s.show.props.src!)))!.stop();
    const a = t.proc.calls[0]!.args;
    expect(a[a.indexOf("-ss") + 1]).toBe("120");
    expect(t.ytCalls).toHaveLength(1); // no second search: it is the same video
  });
  it("points to the video's own buttons for pause, resume and volume", async () => {
    const t = make();
    await t.hub.play({ url: URL });
    for (const action of ["pause", "resume", "volume"] as const) {
      const r = await t.hub.control({ action, level: 30 });
      expect(r).toEqual({ ok: true, text: expect.stringMatching(/own buttons/i) });
    }
  });
  it("says there is nothing playing when there is nothing", async () => {
    expect(await make().hub.control({ action: "pause" })).toEqual({ ok: false, text: expect.stringMatching(/nothing is playing/i) });
  });
});

describe("playing in a window on the PC", () => {
  it("hands the link to the PC's player, with the start and the height, and says so", async () => {
    const host = fakeHost();
    const t = make({ video: { output: "host" }, host });
    const r = await t.hub.play({ url: URL, start: 30 });
    expect(r).toEqual({ ok: true, text: 'Playing "Never Gonna Give You Up" by Rick Astley in a window on this PC.' });
    expect(host.calls[0]).toEqual(["open", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", { start: 30, maxHeight: 720 }]);
    expect(t.proc.calls).toEqual([]); // ffmpeg is not used for a window on the PC
  });
  it("lets one request choose, whatever the setting says", async () => {
    const host = fakeHost();
    const t = make({ host });
    expect((await t.hub.play({ url: URL, output: "host" })).ok).toBe(true);
    expect(host.calls[0]![0]).toBe("open");
    const screen = await make({ video: { output: "host" }, host }).hub.play({ url: URL, output: "screen" });
    expect(screen).toMatchObject({ ok: true, show: { id: "video-now" } });
  });
  it("passes pause, resume, seek, volume and stop to the player", async () => {
    const host = fakeHost();
    const t = make({ video: { output: "host" }, host });
    await t.hub.play({ url: URL });
    host.calls.length = 0;
    await t.hub.control({ action: "pause" });
    await t.hub.control({ action: "resume" });
    await t.hub.control({ action: "seek", seconds: 75 });
    await t.hub.control({ action: "volume", level: 40 });
    const stop = await t.hub.control({ action: "stop" });
    expect(host.calls).toEqual([["pause", true], ["pause", false], ["seek", 75], ["volume", 40], ["stop"]]);
    expect(stop.ok).toBe(true);
  });
  it("says what the player said when it cannot open it", async () => {
    const t = make({ video: { output: "host" }, host: fakeHost({ openError: "mpv could not open or play that file." }) });
    expect(await t.hub.play({ url: URL })).toEqual({ ok: false, text: "mpv could not open or play that file." });
  });
  it("says so when this Friend has no player for the PC", async () => {
    const t = make({ video: { output: "host" } });
    expect(await t.hub.play({ url: URL })).toEqual({ ok: false, text: expect.stringMatching(/window on this PC is not available/i) });
  });
});

describe("a browser window on the PC, when there is no mpv", () => {
  const NO_MPV: VideoStatus = { ...OK, mpv: { found: false, install: "mpv is not installed." } };
  it("opens Friend's own video address in the PC's browser, which needs nothing installed beyond ffmpeg", async () => {
    const t = make({ status: NO_MPV, video: { output: "host" }, browser: true });
    const r = await t.hub.play({ url: URL });
    expect(r).toEqual({ ok: true, text: 'Playing "Never Gonna Give You Up" by Rick Astley in a browser window on this PC.' });
    expect(t.opened).toHaveLength(1);
    expect(t.opened[0]).toMatch(/^http:\/\/127\.0\.0\.1:8787\/api\/video\/[0-9a-f]{32}\?o=[0-9a-f]{32}$/);
  });
  it("prefers mpv when it is there", async () => {
    const host = fakeHost();
    const t = make({ video: { output: "host" }, host, browser: true });
    await t.hub.play({ url: URL });
    expect(host.calls[0]![0]).toBe("open");
    expect(t.opened).toEqual([]);
  });
  it("lets only that address and that ticket in without signing in, and only for a while", async () => {
    const t = make({ status: NO_MPV, video: { output: "host" }, browser: true });
    await t.hub.play({ url: URL });
    const [, id, nonce] = /video\/([0-9a-f]{32})\?o=([0-9a-f]{32})/.exec(t.opened[0]!)!;
    expect(t.hub.ticketOk(id!, nonce!)).toBe(true);
    expect(t.hub.ticketOk(id!, "0".repeat(32))).toBe(false);
    expect(t.hub.ticketOk("1".repeat(32), nonce!)).toBe(false);
    expect(t.hub.ticketOk(id!, "not-a-ticket")).toBe(false);
    t.advance(11 * 60 * 1000);
    expect(t.hub.ticketOk(id!, nonce!)).toBe(false);
  });
  it("says so when the browser could not be opened", async () => {
    const t = make({ status: NO_MPV, video: { output: "host" }, browser: true, browserWorks: false });
    expect(await t.hub.play({ url: URL })).toEqual({ ok: false, text: expect.stringMatching(/could not open a browser window/i) });
  });
  it("needs ffmpeg for that, and downloads it when it is missing", async () => {
    const prov = fakeProvisioner();
    const t = make({ statuses: [{ ...NO_MPV, ffmpeg: { found: false } }, NO_MPV], provisioner: prov, video: { output: "host" }, browser: true });
    await t.hub.play({ url: URL });
    expect(prov.calls).toEqual([["ffmpeg"]]); // only what is missing
  });
  it("stop ends the stream; pause, resume, volume and seek point to the player in the window", async () => {
    const t = make({ status: NO_MPV, video: { output: "host" }, browser: true });
    await t.hub.play({ url: URL });
    const [, id] = /video\/([0-9a-f]{32})/.exec(t.opened[0]!)!;
    (await t.hub.streamOf(id!))!;
    for (const action of ["pause", "resume", "volume", "seek"] as const) expect(await t.hub.control({ action }), action).toEqual({ ok: true, text: expect.stringMatching(/player in the browser window/i) });
    expect((await t.hub.control({ action: "stop" })).ok).toBe(true);
    expect(t.proc.children[0]!.killed).toBe(true);
  });
  it("still says to install mpv when there is no way to open a browser", async () => {
    const t = make({ status: NO_MPV, video: { output: "host" }, host: fakeHost() });
    const r = await t.hub.play({ url: URL });
    expect(r).toEqual({ ok: false, text: expect.stringMatching(/mpv/) });
  });
});

describe("finding the programs Friend downloaded", () => {
  it("looks in Friend's own tools folder when it looks for the helpers, so a program it just downloaded is found at once", async () => {
    const dataDir = "C:/Users/me/.friend";
    const yt = managedPath(dataDir, "yt-dlp", "win32");
    const ff = managedPath(dataDir, "ffmpeg", "win32");
    const hub = new VideoHub({
      config: () => ({ video: { installed: true, enabled: true, output: "screen", maxHeight: 720, maxMinutes: 240, allowedSites: [], ytdlp: "", ffmpeg: "", autoInstall: true }, music: { hostPlayer: "" } }) as never,
      dataDir,
      find: { platform: "win32", env: {}, exists: (p) => p === yt || p === ff, run: async (cmd) => (cmd === yt ? { code: 0, out: "2026.10.01" } : cmd === ff ? { code: 0, out: "ffmpeg version 7.1" } : { code: -1, out: "" }) },
    });
    const s = await hub.refresh();
    expect(s.ytdlp).toMatchObject({ found: true, path: yt, version: "2026.10.01" });
    expect(s.ffmpeg).toMatchObject({ found: true, path: ff });
  });
});

describe("setting the helper programs up by itself", () => {
  const MISSING: VideoStatus = { ...OK, ytdlp: { found: false, install: "yt-dlp is not installed." }, ffmpeg: { found: false, install: "ffmpeg is not installed." } };

  it("downloads what is missing when someone asks for a video, then plays it in the same request", async () => {
    const prov = fakeProvisioner();
    const t = make({ statuses: [MISSING, OK], provisioner: prov });
    const r = await t.hub.play({ url: URL });
    expect(prov.calls).toEqual([["yt-dlp", "ffmpeg"]]);
    expect(r).toMatchObject({ ok: true, show: { id: "video-now" } });
  });

  it("asks only for what the chosen place to play needs: the PC window needs no ffmpeg", async () => {
    const prov = fakeProvisioner();
    const t = make({ statuses: [{ ...OK, ytdlp: { found: false } }, OK], provisioner: prov, video: { output: "host" }, host: fakeHost() });
    await t.hub.play({ url: URL });
    expect(prov.calls).toEqual([["yt-dlp"]]);
  });

  it("does not download anything when everything is there", async () => {
    const prov = fakeProvisioner();
    await make({ provisioner: prov }).hub.play({ url: URL });
    expect(prov.calls).toEqual([]);
  });

  it("does not download when the owner turned that off, and says how to install by hand instead", async () => {
    const prov = fakeProvisioner();
    const r = await make({ status: MISSING, provisioner: prov, video: { autoInstall: false } }).hub.play({ url: URL });
    expect(prov.calls).toEqual([]);
    expect(r).toEqual({ ok: false, text: expect.stringMatching(/yt-dlp is not installed/) });
  });

  it("says plainly when the download failed, with its reason", async () => {
    const prov = fakeProvisioner({ onEnsure: async () => ({ ok: false, error: "Friend could not download ffmpeg. Check the internet connection and try again." }) });
    const r = await make({ status: MISSING, provisioner: prov }).hub.play({ url: URL });
    expect(r).toEqual({ ok: false, text: expect.stringMatching(/could not download ffmpeg/) });
  });

  it("says it is still downloading, instead of making the owner wait for a big download, and carries on in the background", async () => {
    let finish!: (v: { ok: true }) => void;
    const slow = new Promise<{ ok: true }>((r) => (finish = r));
    const prov = fakeProvisioner({ onEnsure: () => slow });
    const t = make({ status: MISSING, provisioner: prov });
    const r = await t.hub.play({ url: URL });
    expect(r).toEqual({ ok: false, text: expect.stringMatching(/downloading the video tools.*first time only.*ask again in a minute/i) });
    finish({ ok: true });
  });

  it("prepare() downloads whatever the plugin needs and then looks again, so the plugin page is true", async () => {
    const prov = fakeProvisioner();
    const t = make({ statuses: [MISSING, OK], provisioner: prov });
    await t.hub.prepare();
    expect(prov.calls).toEqual([["yt-dlp", "ffmpeg"]]);
    expect(t.hub.status()).toMatchObject({ ytdlp: { found: true }, ffmpeg: { found: true } });
  });

  it("shows how the setup is going next to what was found", async () => {
    const prov = fakeProvisioner({ busy: true });
    const t = make({ provisioner: prov });
    await t.hub.refresh();
    expect(t.hub.status()?.setup).toMatchObject({ busy: true });
  });
});

describe("what is playing and what is missing", () => {
  it("tells what is playing, and that nothing is", async () => {
    const t = make();
    expect(t.hub.nowPlaying()).toBe("Nothing is playing.");
    await t.hub.play({ url: URL });
    expect(t.hub.nowPlaying()).toMatch(/Never Gonna Give You Up.*Rick Astley.*Friend screen/);
  });
  it("check lists the three programs, and for each one that is missing the way to install it", async () => {
    const ok = await make().hub.check();
    expect(ok.text).toMatch(/yt-dlp 2026\.10\.01/);
    expect(ok.text).toMatch(/ffmpeg 7\.1/);
    expect(ok.text).toMatch(/mpv 0\.39/);
    const missing = await make({ status: { ...OK, ffmpeg: { found: false, install: "ffmpeg is not installed. Install it once with: winget install ffmpeg." } } }).hub.check();
    expect(missing.text).toMatch(/ffmpeg.*not found.*winget install ffmpeg/is);
  });
});
