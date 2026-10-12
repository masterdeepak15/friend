import { describe, expect, it } from "vitest";
import { resolveVideo, type YtRun } from "./resolve";

const resolveHost = async (host: string): Promise<string[]> => (host === "localhost.example.org" ? ["127.0.0.1"] : ["93.184.216.34"]);

const youtube = {
  id: "dQw4w9WgXcQ",
  title: "Never Gonna Give You Up",
  uploader: "Rick Astley",
  duration: 213,
  webpage_url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
  is_live: false,
  requested_formats: [
    { url: "https://rr3---sn-abc.googlevideo.com/videoplayback?id=v", vcodec: "avc1.64001f", acodec: "none", height: 720, protocol: "https", http_headers: { "User-Agent": "Mozilla/5.0", Accept: "*/*", "X-Evil": "a\r\nInjected: yes" } },
    { url: "https://rr3---sn-abc.googlevideo.com/videoplayback?id=a", vcodec: "none", acodec: "mp4a.40.2", height: null, protocol: "https", http_headers: { "User-Agent": "Mozilla/5.0" } },
  ],
};
const single = { id: "x1", title: "A clip", uploader: "Someone", duration: 60, webpage_url: "https://vimeo.com/1", url: "https://vod.example.org/clip.mp4", vcodec: "vp9", acodec: "opus", protocol: "https", http_headers: { Referer: "https://vimeo.com/" } };

function fake(json: unknown, over: { code?: number; err?: string } = {}): { run: YtRun; calls: { cmd: string; args: string[] }[] } {
  const calls: { cmd: string; args: string[] }[] = [];
  return {
    calls,
    run: async (cmd, args) => {
      calls.push({ cmd, args });
      return { code: over.code ?? 0, out: typeof json === "string" ? json : JSON.stringify(json), err: over.err ?? "" };
    },
  };
}
const deps = (run: YtRun, video: Partial<{ maxHeight: number; maxMinutes: number; allowedSites: string[] }> = {}) => ({ ytdlp: "yt-dlp", video: { maxHeight: 720, maxMinutes: 240, allowedSites: [] as string[], ...video }, run, resolve: resolveHost });

describe("resolving a link", () => {
  it("runs yt-dlp with the fixed safe command line and the link after --, then reads what it found", async () => {
    const { run, calls } = fake(youtube);
    const r = await resolveVideo({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, deps(run));
    expect(r.ok).toBe(true);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.cmd).toBe("yt-dlp");
    const a = calls[0]!.args;
    for (const flag of ["--ignore-config", "--no-playlist", "--no-warnings", "--skip-download", "-J"]) expect(a, flag).toContain(flag);
    expect(a.slice(-2)).toEqual(["--", "https://www.youtube.com/watch?v=dQw4w9WgXcQ"]);
    expect(a[a.indexOf("-f") + 1]).toMatch(/height<=720/);
    expect(a.some((x) => /^--(exec|cookies|config|plugin|netrc|proxy)/.test(x))).toBe(false);
  });

  it("gives the title, who made it, how long, and the inputs ffmpeg will read (a picture and a sound)", async () => {
    const r = await resolveVideo({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, deps(fake(youtube).run));
    expect(r).toMatchObject({ ok: true, info: { id: "dQw4w9WgXcQ", title: "Never Gonna Give You Up", uploader: "Rick Astley", durationSec: 213, live: false, webpage: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", transcodeVideo: false, transcodeAudio: false } });
    if (!r.ok) throw new Error("not ok");
    expect(r.info.inputs.map((i) => i.kind)).toEqual(["video", "audio"]);
    expect(r.info.inputs[0]!.url).toContain("googlevideo.com");
  });

  it("keeps request headers a site needs and drops any that could carry a second line", async () => {
    const r = await resolveVideo({ url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }, deps(fake(youtube).run));
    if (!r.ok) throw new Error("not ok");
    expect(r.info.inputs[0]!.headers).toMatchObject({ "User-Agent": "Mozilla/5.0", Accept: "*/*" });
    expect(JSON.stringify(r.info.inputs)).not.toMatch(/Injected|X-Evil/);
  });

  it("reads a site that gives one address for picture and sound, and says what needs converting", async () => {
    const r = await resolveVideo({ url: "https://vimeo.com/1" }, deps(fake(single).run));
    expect(r).toMatchObject({ ok: true, info: { transcodeVideo: true, transcodeAudio: true } });
    if (r.ok) expect(r.info.inputs).toEqual([{ url: "https://vod.example.org/clip.mp4", kind: "both", headers: { Referer: "https://vimeo.com/" } }]);
  });

  it("searches YouTube for words and takes the first result", async () => {
    const { run, calls } = fake({ _type: "playlist", entries: [youtube, { ...youtube, id: "second" }] });
    const r = await resolveVideo({ query: "never gonna give you up" }, deps(run));
    expect(r).toMatchObject({ ok: true, info: { id: "dQw4w9WgXcQ" } });
    expect(calls[0]!.args.slice(-2)).toEqual(["--", "ytsearch1:never gonna give you up"]);
    expect((await resolveVideo({ query: "x" }, deps(fake({ _type: "playlist", entries: [] }).run)))).toEqual({ ok: false, error: expect.stringMatching(/did not find/i) });
  });

  it("needs a link or words, and a link must pass the address check before yt-dlp is ever started", async () => {
    const { run, calls } = fake(youtube);
    expect(await resolveVideo({}, deps(run))).toEqual({ ok: false, error: expect.stringMatching(/what to play/i) });
    for (const bad of ["http://localhost/v", "file:///etc/passwd", "https://localhost.example.org/v", "http://192.168.0.1/x"]) {
      expect((await resolveVideo({ url: bad }, deps(run))).ok, bad).toBe(false);
    }
    expect(calls).toEqual([]);
  });

  it("follows the owner's list of sites, for a link and for a search", async () => {
    const { run, calls } = fake(youtube);
    expect((await resolveVideo({ url: "https://vimeo.com/1" }, deps(run, { allowedSites: ["youtube.com"] }))).ok).toBe(false);
    expect(calls).toEqual([]);
    expect((await resolveVideo({ query: "x" }, deps(run, { allowedSites: ["vimeo.com"] })))).toEqual({ ok: false, error: expect.stringMatching(/search uses YouTube.*allowed list/i) });
    expect((await resolveVideo({ query: "x" }, deps(fake({ entries: [youtube] }).run, { allowedSites: ["youtube.com"] }))).ok).toBe(true);
  });

  it("refuses media addresses that point inside the owner's network, even when the page looked fine", async () => {
    const evil = { ...youtube, requested_formats: [{ ...youtube.requested_formats[0]!, url: "https://localhost.example.org/videoplayback" }, youtube.requested_formats[1]!] };
    const r = await resolveVideo({ url: "https://www.youtube.com/watch?v=x" }, deps(fake(evil).run));
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/this PC or your network/i) });
    const file = { ...single, url: "file:///C:/secret.mp4" };
    expect((await resolveVideo({ url: "https://vimeo.com/1" }, deps(fake(file).run))).ok).toBe(false);
  });

  it("refuses a video longer than the owner's limit, and lets a live stream through", async () => {
    const long = await resolveVideo({ url: "https://www.youtube.com/watch?v=x" }, deps(fake({ ...youtube, duration: 7200 }).run, { maxMinutes: 60 }));
    expect(long).toEqual({ ok: false, error: expect.stringMatching(/longer than the limit.*60 minutes/i) });
    const live = await resolveVideo({ url: "https://www.youtube.com/watch?v=x" }, deps(fake({ ...youtube, duration: null, is_live: true }).run, { maxMinutes: 60 }));
    expect(live).toMatchObject({ ok: true, info: { live: true, durationSec: null } });
  });

  it("says what went wrong in a sentence, and never repeats yt-dlp's own words (they can hold addresses)", async () => {
    const cases: [string, RegExp][] = [
      ["ERROR: Unsupported URL: https://secret.example.org/x", /cannot find a video/i],
      ["ERROR: [youtube] abc: Video unavailable. This video is private", /not available/i],
      ["ERROR: [youtube] abc: Sign in to confirm you're not a bot", /not available|login/i],
      ["ERROR: HTTP Error 429: Too Many Requests", /slow down/i],
      ["ERROR: Unable to download webpage: <urlopen error timed out>", /did not answer/i],
      ["ERROR: something odd at C:\\Users\\me\\x with token=SECRET", /could not get that video/i],
    ];
    for (const [err, want] of cases) {
      const r = await resolveVideo({ url: "https://www.youtube.com/watch?v=x" }, deps(fake("", { code: 1, err }).run));
      expect(r, err).toEqual({ ok: false, error: expect.stringMatching(want) });
      expect(JSON.stringify(r)).not.toMatch(/secret\.example|Users|SECRET/);
    }
  });

  it("copes with output that is not JSON, and with a program that cannot start", async () => {
    expect(await resolveVideo({ url: "https://www.youtube.com/watch?v=x" }, deps(fake("not json").run))).toEqual({ ok: false, error: expect.stringMatching(/could not get that video/i) });
    const dead: YtRun = async () => {
      throw new Error("spawn yt-dlp ENOENT");
    };
    expect(await resolveVideo({ url: "https://www.youtube.com/watch?v=x" }, deps(dead))).toEqual({ ok: false, error: expect.stringMatching(/could not start yt-dlp/i) });
  });
});
