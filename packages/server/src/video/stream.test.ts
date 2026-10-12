import { describe, expect, it } from "vitest";
import type { VideoInfo } from "./resolve";
import { ffmpegArgs, startStream } from "./stream";
import { fakeSpawn } from "./testing/fakeProcess";

const base: VideoInfo = {
  id: "x",
  title: "T",
  uploader: "U",
  durationSec: 100,
  webpage: "https://example.com/v",
  live: false,
  transcodeVideo: false,
  transcodeAudio: false,
  inputs: [
    { url: "https://cdn.example.org/v.mp4", kind: "video", headers: { "User-Agent": "UA", Accept: "*/*" } },
    { url: "https://cdn.example.org/a.m4a", kind: "audio", headers: { "User-Agent": "UA" } },
  ],
};
const o = { startSec: 0, maxHeight: 720, maxMinutes: 240 };
const idx = (a: string[], v: string) => a.indexOf(v);

describe("the ffmpeg command", () => {
  it("joins a picture and a sound without converting either when the browser can play both", () => {
    const a = ffmpegArgs(base, o);
    expect(a.slice(0, 3)).toEqual(["-hide_banner", "-loglevel", "error"]);
    expect(a).toContain("-nostdin");
    expect(a.filter((x) => x === "-protocol_whitelist")).toHaveLength(2); // before each address
    expect(a[a.indexOf("-protocol_whitelist") + 1]).toBe("http,https,tcp,tls,crypto");
    expect(a.filter((x) => x === "-i")).toHaveLength(2);
    expect(a[idx(a, "-c:v") + 1]).toBe("copy");
    expect(a[idx(a, "-c:a") + 1]).toBe("copy");
    expect(a.join(" ")).toContain("-map 0:v:0 -map 1:a:0");
    expect(a.slice(-2)).toEqual(["mp4", "pipe:1"]);
    expect(a[idx(a, "-movflags") + 1]).toBe("frag_keyframe+empty_moov+default_base_moof");
    expect(a[idx(a, "-t") + 1]).toBe(String(240 * 60));
    expect(a).not.toContain("-ss");
  });

  it("puts each input's headers before that input, one line each, ended with CRLF", () => {
    const a = ffmpegArgs(base, o);
    const first = a.indexOf("-headers");
    expect(a[first + 1]).toBe("User-Agent: UA\r\nAccept: */*\r\n");
    expect(a[first + 2]).toBe("-protocol_whitelist");
    expect(a.indexOf("-i")).toBeGreaterThan(first);
    const second = a.indexOf("-headers", first + 1);
    expect(a[second + 1]).toBe("User-Agent: UA\r\n");
  });

  it("starts at a time by seeking each input before it is opened", () => {
    const a = ffmpegArgs(base, { ...o, startSec: 90 });
    expect(a.filter((x) => x === "-ss")).toHaveLength(2);
    for (let i = 0; i < a.length; i++) if (a[i] === "-ss") expect(a[i + 1]).toBe("90");
    for (let i = 0; i < a.length; i++) if (a[i] === "-i") expect(a[i - 2]).toBe("-ss");
  });

  it("converts a picture the browser cannot play, to the height the owner chose at most, and a sound that is not AAC", () => {
    const a = ffmpegArgs({ ...base, transcodeVideo: true, transcodeAudio: true }, { ...o, maxHeight: 480 });
    expect(a[idx(a, "-c:v") + 1]).toBe("libx264");
    expect(a[idx(a, "-vf") + 1]).toBe("scale=-2:'min(ih,480)'");
    expect(a).toContain("yuv420p");
    expect(a[idx(a, "-c:a") + 1]).toBe("aac");
  });

  it("reads one address that holds both, and takes the sound only if there is one", () => {
    const one: VideoInfo = { ...base, inputs: [{ url: "https://cdn.example.org/all.mp4", kind: "both", headers: {} }] };
    const a = ffmpegArgs(one, o);
    expect(a.filter((x) => x === "-i")).toHaveLength(1);
    expect(a.join(" ")).toContain("-map 0:v:0 -map 0:a:0?");
    expect(a).not.toContain("-headers");
  });

  it("keeps an address from being read as an option", () => {
    const a = ffmpegArgs({ ...base, inputs: [{ url: "https://cdn.example.org/v.mp4", kind: "both", headers: {} }] }, o);
    const i = a.indexOf("-i");
    expect(a[i + 1]).toBe("https://cdn.example.org/v.mp4");
    expect(a[i + 1]!.startsWith("-")).toBe(false);
  });
});

describe("starting a stream", () => {
  it("runs ffmpeg and hands out what it writes", async () => {
    const f = fakeSpawn();
    const h = startStream("ffmpeg", base, o, { spawn: f.spawn as never });
    expect(f.calls[0]!.cmd).toBe("ffmpeg");
    expect(f.calls[0]!.args).toEqual(ffmpegArgs(base, o));
    const chunks: Buffer[] = [];
    for await (const c of h.stream) {
      chunks.push(c as Buffer);
      h.stop();
    }
    expect(Buffer.concat(chunks).toString()).toBe("FMP4DATA");
  });

  it("stops ffmpeg when asked, once, and reports that it ended", async () => {
    const f = fakeSpawn();
    const h = startStream("ffmpeg", base, o, { spawn: f.spawn as never });
    h.stop();
    h.stop();
    expect(f.children[0]!.killed).toBe(true);
    await h.exited;
  });

  it("says so, in a sentence, when ffmpeg cannot start", async () => {
    const f = fakeSpawn();
    f.failToStart = true;
    expect(() => startStream("ffmpeg", base, o, { spawn: f.spawn as never })).toThrow(/could not start ffmpeg/i);
  });

  it("ends the stream with an error when ffmpeg stops with a failure before sending anything", async () => {
    const f = fakeSpawn();
    f.output = null;
    const h = startStream("ffmpeg", base, o, { spawn: f.spawn as never });
    const failed = new Promise<boolean>((r) => h.stream.once("error", () => r(true)));
    f.children[0]!.stderr.write("Server returned 403 Forbidden");
    f.children[0]!.finish(1);
    expect(await failed).toBe(true);
    expect(await h.exited).toBe(1);
  });
});
