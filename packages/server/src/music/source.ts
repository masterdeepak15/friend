import { makeRef, parseRef, type MusicSourceId } from "@friend/protocol";
import type { MusicLibrary } from "./library";

/** One track from any source, addressed by a ref (`local:<id>` or `spotify:<id>`). */
export interface SourceTrack {
  ref: string;
  source: MusicSourceId;
  title: string;
  artist: string;
  album: string;
  durationSec: number | null;
}

export interface SourceStatus {
  connected: boolean;
  /** What the owner has to do or have before this source works, in plain words (null when nothing). */
  needs: string | null;
  account: string | null;
  /** False when the account can be searched but not played (Spotify without Premium). Missing means it can play. */
  canPlay?: boolean;
}

/** Somewhere music comes from. A new service is one more implementation of this and one more entry in the registry. */
export interface MusicSource {
  id: MusicSourceId;
  status(): SourceStatus;
  search(query: string, limit: number): Promise<SourceTrack[]>;
  playlists(limit: number): Promise<{ id: string; name: string; tracks: number }[]>;
  tracksOf(playlistId: string, limit: number): Promise<SourceTrack[]>;
  track(id: string): Promise<SourceTrack | null>;
}

const NAMES: Record<MusicSourceId, string> = { local: "The music folder", spotify: "Spotify" };

/** The owner's music folder as a source. */
export class LocalSource implements MusicSource {
  readonly id = "local" as const;
  constructor(private lib: Pick<MusicLibrary, "ready" | "list" | "find" | "stats">) {}

  status(): SourceStatus {
    const folderSet = this.lib.stats().folderSet;
    return { connected: folderSet, needs: folderSet ? null : "Choose a music folder in Settings, Widgets.", account: null };
  }

  private of(t: { id: string; title: string; artist: string; album: string; durationSec: number | null }): SourceTrack {
    return { ref: makeRef("local", t.id), source: "local", title: t.title, artist: t.artist, album: t.album, durationSec: t.durationSec };
  }

  async search(query: string, limit: number): Promise<SourceTrack[]> {
    await this.lib.ready();
    return this.lib.list({ q: query, limit }).tracks.map((t) => this.of(t));
  }

  async playlists(_limit?: number): Promise<{ id: string; name: string; tracks: number }[]> {
    return [];
  }

  async tracksOf(_playlistId?: string, _limit?: number): Promise<SourceTrack[]> {
    return [];
  }

  async track(id: string): Promise<SourceTrack | null> {
    await this.lib.ready();
    const t = this.lib.find(id);
    return t ? this.of(t) : null;
  }
}

type Wanted = MusicSourceId | "any";

/** All the sources in one place: a search can ask one of them or every one, and a source that cannot answer never stops the others. */
export class MusicSources {
  constructor(
    private sources: MusicSource[],
    private d: { defaultSource: () => Wanted; searchLimit: () => number },
  ) {}

  /** The source a search or a play starts from when none is named. */
  defaultSource(): Wanted {
    return this.d.defaultSource();
  }

  status(): Record<MusicSourceId, SourceStatus> {
    const out = {} as Record<MusicSourceId, SourceStatus>;
    for (const s of this.sources) out[s.id] = s.status();
    return out;
  }

  private pick(source: Wanted): MusicSource[] {
    return source === "any" ? this.sources : this.sources.filter((s) => s.id === source);
  }

  async search(query: string, o: { source?: Wanted; limit?: number } = {}): Promise<{ tracks: SourceTrack[]; notes: string[] }> {
    const cap = this.d.searchLimit();
    const limit = Math.max(1, Math.min(cap, o.limit ?? cap));
    const chosen = this.pick(o.source ?? this.d.defaultSource());
    const notes: string[] = [];
    const lists = await Promise.all(
      chosen.map(async (s): Promise<SourceTrack[]> => {
        const st = s.status();
        if (!st.connected) {
          if (st.needs) notes.push(st.needs);
          return [];
        }
        try {
          return await s.search(query, limit);
        } catch {
          notes.push(`${NAMES[s.id]} could not be searched right now.`);
          return [];
        }
      }),
    );
    const seen = new Set<string>();
    const tracks: SourceTrack[] = [];
    for (let i = 0; tracks.length < limit && lists.some((l) => i < l.length); i++) {
      for (const l of lists) {
        const t = l[i];
        if (t && !seen.has(t.ref) && tracks.length < limit) {
          seen.add(t.ref);
          tracks.push(t);
        }
      }
    }
    return { tracks, notes };
  }

  /** One track by ref (a bare id is a local track). Null when the ref is not valid, the source is off or it is not there. */
  async track(ref: string): Promise<SourceTrack | null> {
    const p = parseRef(ref);
    if (!p) return null;
    const s = this.sources.find((x) => x.id === p.source);
    if (!s || !s.status().connected) return null;
    try {
      return await s.track(p.id);
    } catch {
      return null;
    }
  }
}
