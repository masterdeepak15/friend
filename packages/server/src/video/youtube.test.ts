import { describe, expect, it } from "vitest";
import { searchYoutube, titleOfYoutube, youtubeId } from "./youtube";
import type { YtRun } from "./resolve";

describe("recognising a YouTube link", () => {
  const ID = "dQw4w9WgXcQ";
  it("finds the video id in every usual form", () => {
    for (const u of [
      `https://www.youtube.com/watch?v=${ID}`,
      `https://youtube.com/watch?v=${ID}&t=42s`,
      `https://m.youtube.com/watch?v=${ID}`,
      `https://music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}`,
      `https://youtu.be/${ID}`,
      `https://youtu.be/${ID}?si=abc`,
      `https://www.youtube.com/shorts/${ID}`,
      `https://www.youtube.com/live/${ID}`,
      `https://www.youtube.com/embed/${ID}`,
      `https://www.youtube-nocookie.com/embed/${ID}`,
      `http://www.youtube.com/watch?feature=share&v=${ID}`,
    ]) {
      expect(youtubeId(u), u).toBe(ID);
    }
  });
  it("is null for anything else, including look-alike names, odd ids and links that carry no single video", () => {
    for (const u of [
      "https://vimeo.com/12345",
      `https://youtube.com.evil.example/watch?v=${ID}`,
      `https://notyoutube.com/watch?v=${ID}`,
      `https://www.youtube.com/watch?v=short`,
      `https://www.youtube.com/watch?v=${ID}x`,
      "https://www.youtube.com/playlist?list=PL12345",
      "https://www.youtube.com/@somechannel",
      "https://www.youtube.com/",
      `https://user:pw@www.youtube.com/watch?v=${ID}`,
      `https://www.youtube.com:8443/watch?v=${ID}`,
      "not a link",
      "",
    ]) {
      expect(youtubeId(u), u).toBeNull();
    }
  });
});

describe("the title of a YouTube video, without any program", () => {
  const fetchOk = (async (input: unknown) => {
    expect(String(input)).toMatch(/^https:\/\/www\.youtube\.com\/oembed\?url=.*&format=json$/);
    return new Response(JSON.stringify({ title: "Never Gonna Give You Up", author_name: "Rick Astley" }), { headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  it("asks YouTube's own public title service, and gives the title and the channel", async () => {
    expect(await titleOfYoutube("dQw4w9WgXcQ", { fetch: fetchOk })).toEqual({ title: "Never Gonna Give You Up", uploader: "Rick Astley", embeddable: true });
  });
  it("falls back to a plain name when that does not answer in time or answers badly", async () => {
    const down = (async () => new Response("no", { status: 404 })) as unknown as typeof fetch;
    const hang = ((_: unknown, init?: RequestInit) => new Promise((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as unknown as typeof fetch;
    const junk = (async () => new Response("<html>", { status: 200 })) as unknown as typeof fetch;
    for (const f of [down, hang, junk]) expect(await titleOfYoutube("dQw4w9WgXcQ", { fetch: f, timeoutMs: 50 })).toEqual({ title: "YouTube video", uploader: "", embeddable: true });
  });
  it("knows a video that its owner does not let play on other sites (YouTube answers 401 for it)", async () => {
    for (const status of [401, 403]) {
      const f = (async () => new Response("Unauthorized", { status })) as unknown as typeof fetch;
      expect(await titleOfYoutube("dQw4w9WgXcQ", { fetch: f })).toMatchObject({ embeddable: false });
    }
  });
  it("never puts anything but the id in the address it asks for", async () => {
    let asked = "";
    const spy = (async (input: unknown) => {
      asked = String(input);
      return new Response("{}");
    }) as unknown as typeof fetch;
    await titleOfYoutube("dQw4w9WgXcQ", { fetch: spy });
    expect(new URL(asked).searchParams.get("url")).toBe("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
  });
  it("cuts a long title and strips anything that is not text", async () => {
    const f = (async () => new Response(JSON.stringify({ title: "A".repeat(500) + "\u0007", author_name: "Z\nZ" }))) as unknown as typeof fetch;
    const t = await titleOfYoutube("dQw4w9WgXcQ", { fetch: f });
    expect(t.title.length).toBeLessThanOrEqual(200);
    expect(t.title).not.toMatch(/[\u0000-\u001f]/);
    expect(t.uploader).toBe("Z Z");
  });
});

describe("searching YouTube with yt-dlp, only for the first result", () => {
  const run = (json: unknown, over: { code?: number; err?: string } = {}): { run: YtRun; calls: string[][] } => {
    const calls: string[][] = [];
    return { calls, run: async (_c, args) => (calls.push(args), { code: over.code ?? 0, out: JSON.stringify(json), err: over.err ?? "" }) };
  };
  it("asks for the list of results only (nothing is downloaded or opened), and gives the id and the title", async () => {
    const x = run({ entries: [{ id: "dQw4w9WgXcQ", title: "Never Gonna Give You Up", uploader: "Rick Astley", is_live: false }] });
    const r = await searchYoutube("never gonna give you up", { ytdlp: "yt-dlp", run: x.run });
    expect(r).toEqual({ ok: true, id: "dQw4w9WgXcQ", title: "Never Gonna Give You Up", uploader: "Rick Astley", live: false });
    const a = x.calls[0]!;
    for (const f of ["--ignore-config", "--no-warnings", "--flat-playlist", "-J"]) expect(a).toContain(f);
    expect(a.slice(-2)).toEqual(["--", "ytsearch1:never gonna give you up"]);
  });
  it("says when nothing was found, and when yt-dlp could not run", async () => {
    expect(await searchYoutube("x", { ytdlp: "yt-dlp", run: run({ entries: [] }).run })).toEqual({ ok: false, error: expect.stringMatching(/did not find/i) });
    expect(await searchYoutube("x", { ytdlp: "yt-dlp", run: run({}, { code: 1, err: "ERROR: HTTP Error 429" }).run })).toEqual({ ok: false, error: expect.stringMatching(/slow down/i) });
    const dead: YtRun = async () => {
      throw new Error("ENOENT");
    };
    expect(await searchYoutube("x", { ytdlp: "yt-dlp", run: dead })).toEqual({ ok: false, error: expect.stringMatching(/could not start yt-dlp/i) });
  });
  it("refuses an id that is not one, whatever yt-dlp said", async () => {
    const r = await searchYoutube("x", { ytdlp: "yt-dlp", run: run({ entries: [{ id: "../../etc", title: "x" }] }).run });
    expect(r.ok).toBe(false);
  });
});
