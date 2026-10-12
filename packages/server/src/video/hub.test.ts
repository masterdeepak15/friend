import { describe, expect, it } from "vitest";
import { VideoHub, type VideoHostLike } from "./hub";
import type { YtRun } from "./resolve";
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

function make(over: { video?: Record<string, unknown>; status?: VideoStatus; json?: unknown; host?: VideoHostLike } = {}) {
  const ytCalls: string[][] = [];
  const run: YtRun = async (_cmd, args) => {
    ytCalls.push(args);
    return { code: 0, out: JSON.stringify(over.json ?? youtube), err: "" };
  };
  const proc = fakeSpawn();
  let now = 1_000_000;
  let statusCalls = 0;
  const cfg = { video: { installed: true, enabled: true, output: "screen", maxHeight: 720, maxMinutes: 240, allowedSites: [], ytdlp: "", ffmpeg: "", ...over.video }, music: { hostPlayer: "" } };
  const hub = new VideoHub({
    config: () => cfg as never,
    run,
    spawn: proc.spawn as never,
    resolve: async () => ["93.184.216.34"],
    status: async () => {
      statusCalls++;
      return over.status ?? OK;
    },
    host: over.host,
    clock: () => now,
  });
  return { hub, ytCalls, proc, advance: (ms: number) => (now += ms), statusCalls: () => statusCalls, cfg };
}
const URL = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const srcId = (src: string) => /^\/api\/video\/([0-9a-f]{32})$/.exec(src)![1]!;

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
    const h = await t.hub.streamOf(srcId(r.show.props.src));
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
    (await t.hub.streamOf(srcId(r.show.props.src)))!.stop();
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
    expect(await t.hub.streamOf(srcId(r.show.props.src))).toBeNull();
  });

  it("runs two streams at most: a third ends the oldest", async () => {
    const t = make();
    const ids: string[] = [];
    for (let i = 0; i < 3; i++) {
      const r = await t.hub.play({ url: URL });
      if (!r.ok || !r.show) throw new Error("not ok");
      ids.push(srcId(r.show.props.src));
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
    await t.hub.streamOf(srcId(r.show.props.src));
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
    (await t.hub.streamOf(srcId(s.show.props.src)))!.stop();
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
