import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MusicLibrary } from "./library";

/** A tiny but real MP3: an ID3v2.3 tag (title, artist, album) followed by a few empty MPEG frames. */
function mp3(tags: { title?: string; artist?: string; album?: string } = {}): Buffer {
  const frame = (id: string, text: string) => {
    const body = Buffer.concat([Buffer.from([0]), Buffer.from(text, "latin1")]);
    const head = Buffer.alloc(10);
    head.write(id, 0, "latin1");
    head.writeUInt32BE(body.length, 4);
    return Buffer.concat([head, body]);
  };
  const frames = Buffer.concat([tags.title ? frame("TIT2", tags.title) : Buffer.alloc(0), tags.artist ? frame("TPE1", tags.artist) : Buffer.alloc(0), tags.album ? frame("TALB", tags.album) : Buffer.alloc(0)]);
  const size = frames.length;
  const header = Buffer.concat([Buffer.from("ID3"), Buffer.from([3, 0, 0]), Buffer.from([(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f])]);
  const audio = Buffer.concat(Array.from({ length: 6 }, () => Buffer.concat([Buffer.from([0xff, 0xfb, 0x90, 0x00]), Buffer.alloc(413)])));
  return Buffer.concat([header, frames, audio]);
}

interface Folder {
  dir: string;
  put(rel: string, data?: Buffer | string): void;
}
function folder(): Folder {
  const dir = mkdtempSync(join(tmpdir(), "friend-music-"));
  return {
    dir,
    put(rel, data = Buffer.from("not really audio")) {
      const full = join(dir, ...rel.split("/"));
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, data);
    },
  };
}
const lib = (f: Folder, o: Partial<{ extensions: string[]; maxTracks: number; scanDepth: number }> = {}) =>
  new MusicLibrary({ folder: () => f.dir, extensions: () => o.extensions ?? ["mp3", "m4a", "ogg", "wav", "flac"], maxTracks: () => o.maxTracks ?? 5000, scanDepth: () => o.scanDepth ?? 6 });

describe("scanning the folder", () => {
  it("finds the allowed audio files at any depth, ignoring other files and hidden ones, whatever the letter case", async () => {
    const f = folder();
    f.put("a.mp3");
    f.put("Rock/B.MP3");
    f.put("Rock/Live/c.flac");
    f.put("notes.txt");
    f.put("cover.jpg");
    f.put(".hidden/d.mp3");
    f.put(".secret.mp3");
    const l = lib(f);
    expect((await l.scan()).count).toBe(3);
    expect(l.list({}).tracks.map((t) => t.ext).sort()).toEqual(["flac", "mp3", "mp3"]);
  });

  it("stops at the depth and the track limit, and says so", async () => {
    const f = folder();
    f.put("one.mp3");
    f.put("a/two.mp3");
    f.put("a/b/three.mp3");
    f.put("a/b/c/four.mp3");
    expect((await lib(f, { scanDepth: 2 }).scan()).count).toBe(3);
    const limited = lib(f, { maxTracks: 2 });
    const r = await limited.scan();
    expect(r).toMatchObject({ count: 2, truncated: true });
    expect(limited.list({}).truncated).toBe(true);
  });

  it("is empty, with a reason, when no folder is chosen or the folder is missing", async () => {
    const none = new MusicLibrary({ folder: () => "", extensions: () => ["mp3"], maxTracks: () => 10, scanDepth: () => 3 });
    expect(await none.scan()).toMatchObject({ count: 0, problem: expect.stringMatching(/no music folder/i) });
    const gone = new MusicLibrary({ folder: () => join(tmpdir(), "friend-no-such-folder-xyz"), extensions: () => ["mp3"], maxTracks: () => 10, scanDepth: () => 3 });
    expect(await gone.scan()).toMatchObject({ count: 0, problem: expect.stringMatching(/not found|cannot be read/i) });
  });

  it("follows the settings as they are now, and sees files added later after a rescan", async () => {
    const f = folder();
    f.put("a.mp3");
    let exts = ["mp3"];
    const l = new MusicLibrary({ folder: () => f.dir, extensions: () => exts, maxTracks: () => 100, scanDepth: () => 3 });
    expect((await l.scan()).count).toBe(1);
    f.put("b.ogg");
    exts = ["mp3", "ogg"];
    expect((await l.scan()).count).toBe(2);
  });

  it("does not follow links (a link out of the folder could reach anything)", async () => {
    const f = folder();
    const outside = folder();
    outside.put("secret.mp3");
    f.put("ok.mp3");
    try {
      symlinkSync(outside.dir, join(f.dir, "linked"), "junction");
      symlinkSync(join(outside.dir, "secret.mp3"), join(f.dir, "also.mp3"), "file");
    } catch {
      return; // this system does not allow the test to make links
    }
    const l = lib(f);
    await l.scan();
    expect(l.list({}).tracks.map((t) => t.title)).toEqual(["ok"]);
  });
});

describe("what is known about a track", () => {
  it("reads title, artist and album from the tags", async () => {
    const f = folder();
    f.put("whatever.mp3", mp3({ title: "Blue in Green", artist: "Miles Davis", album: "Kind of Blue" }));
    const l = lib(f);
    await l.scan();
    expect(l.list({}).tracks[0]).toMatchObject({ title: "Blue in Green", artist: "Miles Davis", album: "Kind of Blue" });
  });

  it("falls back to the file name, a 'Artist - Title' name, and the folder as the album", async () => {
    const f = folder();
    f.put("Jazz/Song One.mp3");
    f.put("Jazz/Nina Simone - Feeling Good.mp3");
    const l = lib(f);
    await l.scan();
    const byTitle = Object.fromEntries(l.list({}).tracks.map((t) => [t.title, t]));
    expect(byTitle["Song One"]).toMatchObject({ artist: "", album: "Jazz" });
    expect(byTitle["Feeling Good"]).toMatchObject({ artist: "Nina Simone", album: "Jazz" });
  });

  it("gives a stable id that does not contain the path, and the list never exposes a path", async () => {
    const f = folder();
    f.put("Rock/x.mp3");
    const a = lib(f);
    const b = lib(f);
    await a.scan();
    await b.scan();
    const t = a.list({}).tracks[0]!;
    expect(t.id).toBe(b.list({}).tracks[0]!.id);
    expect(t.id).toMatch(/^[0-9a-f]{16}$/);
    const json = JSON.stringify(a.list({}));
    expect(json).not.toContain(f.dir);
    for (const v of Object.values(t)) if (typeof v === "string") expect(v, v).not.toMatch(/[\\/]/); // a name, never a path
  });
});

describe("searching and paging", () => {
  async function stocked() {
    const f = folder();
    f.put("Miles Davis - So What.mp3", mp3({ title: "So What", artist: "Miles Davis", album: "Kind of Blue" }));
    f.put("Miles Davis - Blue in Green.mp3", mp3({ title: "Blue in Green", artist: "Miles Davis", album: "Kind of Blue" }));
    f.put("John Coltrane - Blue Train.mp3", mp3({ title: "Blue Train", artist: "John Coltrane", album: "Blue Train" }));
    f.put("Daft Punk - Around the World.mp3", mp3({ title: "Around the World", artist: "Daft Punk", album: "Homework" }));
    const l = lib(f);
    await l.scan();
    return l;
  }

  it("matches title, artist and album words, all of them, in any case", async () => {
    const l = await stocked();
    expect(l.list({ q: "miles" }).total).toBe(2);
    expect(l.list({ q: "BLUE green" }).tracks.map((t) => t.title)).toEqual(["Blue in Green"]);
    expect(l.list({ q: "homework" }).tracks.map((t) => t.title)).toEqual(["Around the World"]);
    expect(l.list({ q: "nothing like this" }).total).toBe(0);
  });

  it("puts a title that starts with the words first", async () => {
    const l = await stocked();
    expect(l.list({ q: "blue" }).tracks[0]!.title).toMatch(/^Blue/);
  });

  it("pages, and caps a page", async () => {
    const l = await stocked();
    expect(l.list({ limit: 2 }).tracks).toHaveLength(2);
    const page2 = l.list({ offset: 2, limit: 2 });
    expect(page2.tracks).toHaveLength(2);
    expect(page2.total).toBe(4);
    expect(l.list({ limit: 100000 }).tracks.length).toBeLessThanOrEqual(500);
  });

  it("counts artists and albums", async () => {
    const l = await stocked();
    expect(l.stats()).toMatchObject({ tracks: 4, artists: 3, albums: 3, folderSet: true });
  });
});

describe("opening a track", () => {
  it("gives the real path only for a track Friend listed", async () => {
    const f = folder();
    f.put("a.mp3");
    const l = lib(f);
    await l.scan();
    const id = l.list({}).tracks[0]!.id;
    expect(await l.resolve(id)).toBe(join(realpathSync(f.dir), "a.mp3"));
    expect(await l.resolve("0".repeat(16))).toBeNull();
    expect(await l.resolve("../../etc/passwd")).toBeNull();
    expect(await l.resolve("")).toBeNull();
  });

  it("refuses a track that has been replaced by a link out of the folder since the scan", async () => {
    const f = folder();
    const outside = folder();
    outside.put("secret.mp3");
    f.put("a.mp3");
    const l = lib(f);
    await l.scan();
    const id = l.list({}).tracks[0]!.id;
    const { rmSync } = await import("node:fs");
    rmSync(join(f.dir, "a.mp3"));
    try {
      symlinkSync(join(outside.dir, "secret.mp3"), join(f.dir, "a.mp3"), "file");
    } catch {
      return;
    }
    expect(await l.resolve(id)).toBeNull();
  });

  it("refuses a track that was removed, or that is no longer an allowed kind", async () => {
    const f = folder();
    f.put("a.mp3");
    let exts = ["mp3"];
    const l = new MusicLibrary({ folder: () => f.dir, extensions: () => exts, maxTracks: () => 10, scanDepth: () => 3 });
    await l.scan();
    const id = l.list({}).tracks[0]!.id;
    exts = ["ogg"];
    expect(await l.resolve(id)).toBeNull();
    exts = ["mp3"];
    const { rmSync } = await import("node:fs");
    rmSync(join(f.dir, "a.mp3"));
    expect(await l.resolve(id)).toBeNull();
  });
});

describe("cover pictures", () => {
  it("uses a picture file next to the track, and nothing when there is none", async () => {
    const f = folder();
    f.put("Album/a.mp3");
    f.put("Album/folder.jpg", Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]));
    f.put("Other/b.mp3");
    const l = lib(f);
    await l.scan();
    const [a, b] = ["a", "b"].map((n) => l.list({ q: n }).tracks.find((t) => t.title === n)!);
    expect(a!.cover).toBe(true);
    const cover = await l.cover(a!.id);
    expect(cover).toMatchObject({ mime: "image/jpeg" });
    expect(cover!.data.length).toBe(7);
    expect(b!.cover).toBe(false);
    expect(await l.cover(b!.id)).toBeNull();
  });

  it("ignores a picture that is too big", async () => {
    const f = folder();
    f.put("a.mp3");
    f.put("cover.png", Buffer.alloc(4 * 1024 * 1024));
    const l = lib(f);
    await l.scan();
    expect(await l.cover(l.list({}).tracks[0]!.id)).toBeNull();
  });
});
