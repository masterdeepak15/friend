import { describe, expect, it } from "vitest";
import { LocalSource, MusicSources, type MusicSource, type SourceTrack } from "./source";

const t = (source: "local" | "spotify", id: string, title = id): SourceTrack => ({ ref: `${source}:${id}`, source, title, artist: "A", album: "B", durationSec: 100 });

function fake(id: "local" | "spotify", tracks: SourceTrack[], over: Partial<MusicSource> = {}): MusicSource {
  return {
    id,
    status: () => ({ connected: true, needs: null, account: null }),
    search: async (_q, limit) => tracks.slice(0, limit),
    playlists: async () => [],
    tracksOf: async () => [],
    track: async (x) => tracks.find((y) => y.ref === `${id}:${x}`) ?? null,
    ...over,
  };
}

const deps = (over: { defaultSource?: "local" | "spotify" | "any"; searchLimit?: number } = {}) => ({ defaultSource: () => over.defaultSource ?? "local", searchLimit: () => over.searchLimit ?? 10 });

describe("MusicSources", () => {
  const local = fake("local", [t("local", "0000000000000001"), t("local", "0000000000000002")]);
  const spot = fake("spotify", [t("spotify", "s1"), t("spotify", "s2")]);

  it("uses the default source when none is named", async () => {
    const s = new MusicSources([local, spot], deps({ defaultSource: "spotify" }));
    expect((await s.search("x")).tracks.map((x) => x.ref)).toEqual(["spotify:s1", "spotify:s2"]);
    expect((await s.search("x", { source: "local" })).tracks.every((x) => x.source === "local")).toBe(true);
  });

  it("any: interleaves the sources and drops duplicates", async () => {
    const dup = fake("spotify", [t("spotify", "s1"), t("spotify", "s1"), t("spotify", "s2")]);
    const s = new MusicSources([local, dup], deps({ defaultSource: "any" }));
    expect((await s.search("x")).tracks.map((x) => x.ref)).toEqual(["local:0000000000000001", "spotify:s1", "local:0000000000000002", "spotify:s2"]);
  });

  it("a source that is not connected adds its words to the notes instead of failing", async () => {
    const off = fake("spotify", [], { status: () => ({ connected: false, needs: "Connect your Spotify account.", account: null }) });
    const r = await new MusicSources([local, off], deps({ defaultSource: "any" })).search("x");
    expect(r.tracks).toHaveLength(2);
    expect(r.notes).toEqual(["Connect your Spotify account."]);
  });

  it("a source that throws leaves the other's results and one note", async () => {
    const boom = fake("spotify", [], { search: async () => { throw new Error("secret-token-123 failed"); } });
    const r = await new MusicSources([local, boom], deps({ defaultSource: "any" })).search("x");
    expect(r.tracks).toHaveLength(2);
    expect(r.notes).toHaveLength(1);
    expect(r.notes[0]).toMatch(/Spotify/);
    expect(r.notes[0]).not.toMatch(/secret-token/);
  });

  it("clamps the limit to the search limit setting", async () => {
    const many = fake("local", Array.from({ length: 30 }, (_, i) => t("local", String(i).padStart(16, "0"))));
    const s = new MusicSources([many], deps({ searchLimit: 5 }));
    expect((await s.search("x", { limit: 100 })).tracks).toHaveLength(5);
    expect((await s.search("x", { limit: 2 })).tracks).toHaveLength(2);
  });

  it("resolves a bare id as a local track and a prefixed ref through its source", async () => {
    const s = new MusicSources([local, spot], deps());
    expect((await s.track("0000000000000002"))?.ref).toBe("local:0000000000000002");
    expect((await s.track("spotify:s2"))?.ref).toBe("spotify:s2");
    expect(await s.track("youtube:x")).toBeNull();
    expect(await s.track("spotify:missing")).toBeNull();
  });

  it("reports each source's status", () => {
    expect(new MusicSources([local, spot], deps()).status().spotify.connected).toBe(true);
  });
});

describe("LocalSource", () => {
  const lib = {
    ready: async () => {},
    list: ({ q }: { q?: string; limit?: number }) => ({ tracks: [{ id: "0000000000000001", title: q ?? "t", artist: "A", album: "B", track: 1, durationSec: 90, ext: "mp3", cover: false }], total: 1, truncated: false }),
    find: (id: string) => (id === "0000000000000001" ? { id, title: "t", artist: "A", album: "B", track: 1, durationSec: 90, ext: "mp3", cover: false } : undefined),
    stats: () => ({ tracks: 1, artists: 1, albums: 1, scannedAt: 0, folderSet: true, truncated: false }),
  };

  it("turns library tracks into refs", async () => {
    const s = new LocalSource(lib as never);
    expect((await s.search("hello", 5))[0]).toMatchObject({ ref: "local:0000000000000001", source: "local", title: "hello", durationSec: 90 });
    expect((await s.track("0000000000000001"))?.ref).toBe("local:0000000000000001");
    expect(await s.track("ffffffffffffffff")).toBeNull();
    expect(await s.playlists(5)).toEqual([]);
  });

  it("says what is missing when no folder is chosen", () => {
    const empty = { ...lib, stats: () => ({ ...lib.stats(), folderSet: false }) };
    expect(new LocalSource(empty as never).status()).toMatchObject({ connected: false, needs: expect.stringMatching(/folder/i) });
    expect(new LocalSource(lib as never).status().connected).toBe(true);
  });
});
