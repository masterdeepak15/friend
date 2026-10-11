import { createHash } from "node:crypto";
import { lstat, readdir, readFile, realpath, stat } from "node:fs/promises";
import { basename, extname, join, sep } from "node:path";
import { parseFile } from "music-metadata";

export interface PublicTrack {
  /** A short code Friend made for the track. The screen uses it to ask for the audio; it is not the path. */
  id: string;
  title: string;
  artist: string;
  album: string;
  track: number | null;
  durationSec: number | null;
  ext: string;
  cover: boolean;
}

interface Track extends PublicTrack {
  /** The path inside the music folder. Never sent to a screen. */
  rel: string;
  coverFile: string | null;
  embedded: boolean;
}

export interface LibraryOptions {
  /** The music folder the owner chose (empty: none). Functions, so a changed setting applies at the next scan. */
  folder: () => string;
  extensions: () => string[];
  maxTracks: () => number;
  scanDepth: () => number;
}

export interface ScanResult {
  count: number;
  truncated: boolean;
  at: number;
  problem?: string;
}

const MAX_PAGE = 500;
const MAX_COVER_BYTES = 3 * 1024 * 1024;
const TAG_WORKERS = 6;
const COVER_NAMES = ["folder", "cover", "front", "album"];
const COVER_EXT: Record<string, string> = { jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png" };

const idOf = (rel: string): string => createHash("sha1").update(rel.split(sep).join("/")).digest("hex").slice(0, 16);
const publicOf = ({ rel: _rel, coverFile: _c, embedded: _e, ...rest }: Track): PublicTrack => rest;

/**
 * The owner's music, found by walking one folder. Only that folder is ever read: links are not followed, hidden files are skipped,
 * only the chosen audio kinds are listed, and a file is opened only through an id Friend made, after it is checked again.
 */
export class MusicLibrary {
  private tracks: Track[] = [];
  private root = "";
  private scannedAt = 0;
  private truncated = false;
  private folderSet = false;
  private running: Promise<ScanResult> | null = null;

  constructor(private o: LibraryOptions) {}

  /** Reads the folder again. One scan at a time; a second call waits for the one under way. */
  scan(): Promise<ScanResult> {
    this.running ??= this.doScan().finally(() => {
      this.running = null;
    });
    return this.running;
  }

  private async doScan(): Promise<ScanResult> {
    const at = Date.now();
    const chosen = this.o.folder().trim();
    this.folderSet = chosen !== "";
    const none = (problem: string): ScanResult => {
      this.tracks = [];
      this.truncated = false;
      this.scannedAt = at;
      return { count: 0, truncated: false, at, problem };
    };
    if (!this.folderSet) return none("No music folder is set.");
    let root: string;
    try {
      root = await realpath(chosen);
      if (!(await stat(root)).isDirectory()) return none("The music folder was not found or cannot be read.");
    } catch {
      return none("The music folder was not found or cannot be read.");
    }

    const allowed = new Set(this.o.extensions().map((e) => e.toLowerCase().replace(/^\./, "")));
    const max = this.o.maxTracks();
    const depthLimit = this.o.scanDepth();
    const found: { rel: string; coverFile: string | null }[] = [];
    let truncated = false;

    const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
      if (truncated) return;
      let entries;
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch {
        return; // a folder that cannot be read is skipped
      }
      entries.sort((a, b) => a.name.localeCompare(b.name));
      let coverFile: string | null = null;
      for (const e of entries) {
        if (e.isFile() && !e.name.startsWith(".") && COVER_NAMES.includes(basename(e.name, extname(e.name)).toLowerCase()) && COVER_EXT[extname(e.name).slice(1).toLowerCase()]) {
          coverFile ??= rel ? `${rel}${sep}${e.name}` : e.name;
        }
      }
      for (const e of entries) {
        if (truncated) return;
        if (e.name.startsWith(".") || e.isSymbolicLink()) continue;
        const childRel = rel ? `${rel}${sep}${e.name}` : e.name;
        if (e.isDirectory()) {
          if (depth < depthLimit) await walk(join(dir, e.name), childRel, depth + 1);
        } else if (e.isFile() && allowed.has(extname(e.name).slice(1).toLowerCase())) {
          if (found.length >= max) {
            truncated = true;
            return;
          }
          found.push({ rel: childRel, coverFile });
        }
      }
    };
    await walk(root, "", 0);

    const tracks: Track[] = new Array(found.length);
    let next = 0;
    const worker = async (): Promise<void> => {
      for (;;) {
        const i = next++;
        if (i >= found.length) return;
        tracks[i] = await this.describe(root, found[i]!.rel, found[i]!.coverFile);
      }
    };
    await Promise.all(Array.from({ length: Math.min(TAG_WORKERS, found.length) }, worker));

    this.root = root;
    this.tracks = tracks;
    this.truncated = truncated;
    this.scannedAt = at;
    return { count: tracks.length, truncated, at };
  }

  /** Title, artist, album and length from the tags, or from the file name and folder when there are none. */
  private async describe(root: string, rel: string, coverFile: string | null): Promise<Track> {
    const name = basename(rel);
    const ext = extname(name).slice(1).toLowerCase();
    const stem = name.slice(0, name.length - extname(name).length);
    const parent = rel.includes(sep) ? basename(join(rel, "..")) : "";
    let title = "";
    let artist = "";
    let album = "";
    let trackNo: number | null = null;
    let durationSec: number | null = null;
    let embedded = false;
    try {
      const m = await parseFile(join(root, rel));
      title = m.common.title?.trim() ?? "";
      artist = (m.common.artist ?? m.common.albumartist ?? "").trim();
      album = m.common.album?.trim() ?? "";
      trackNo = m.common.track?.no ?? null;
      durationSec = typeof m.format.duration === "number" && Number.isFinite(m.format.duration) ? Math.round(m.format.duration) : null;
      embedded = (m.common.picture?.length ?? 0) > 0;
    } catch {
      /* no readable tags: the file name is used */
    }
    if (!title) {
      const split = /^(.{1,80}?)\s+-\s+(.+)$/.exec(stem);
      title = split ? split[2]!.trim() : stem;
      if (!artist && split) artist = split[1]!.trim();
    }
    if (!album) album = parent;
    return { id: idOf(rel), title, artist, album, track: trackNo, durationSec, ext, cover: embedded || coverFile !== null, rel, coverFile, embedded };
  }

  list(o: { q?: string; offset?: number; limit?: number }): { tracks: PublicTrack[]; total: number; truncated: boolean } {
    const words = (o.q ?? "").toLowerCase().split(/\s+/).filter(Boolean);
    const hay = (t: Track) => `${t.title} ${t.artist} ${t.album}`.toLowerCase();
    const q = words.join(" ");
    let rows = this.tracks.filter((t) => words.every((w) => hay(t).includes(w)));
    const score = (t: Track) => (q && t.title.toLowerCase().startsWith(q) ? 0 : q && t.title.toLowerCase().includes(q) ? 1 : 2);
    rows = [...rows].sort((a, b) => score(a) - score(b) || a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album) || (a.track ?? 0) - (b.track ?? 0) || a.title.localeCompare(b.title));
    const offset = Math.max(0, Math.floor(o.offset ?? 0));
    const limit = Math.min(MAX_PAGE, Math.max(1, Math.floor(o.limit ?? 100)));
    return { tracks: rows.slice(offset, offset + limit).map(publicOf), total: rows.length, truncated: this.truncated };
  }

  find(id: string): PublicTrack | undefined {
    const t = this.tracks.find((x) => x.id === id);
    return t ? publicOf(t) : undefined;
  }

  stats(): { tracks: number; artists: number; albums: number; scannedAt: number; folderSet: boolean; truncated: boolean } {
    const distinct = (f: (t: Track) => string) => new Set(this.tracks.map(f).filter(Boolean).map((s) => s.toLowerCase())).size;
    return { tracks: this.tracks.length, artists: distinct((t) => t.artist), albums: distinct((t) => t.album), scannedAt: this.scannedAt, folderSet: this.folderSet, truncated: this.truncated };
  }

  /** The real path of a listed track, checked again now: still a plain file inside the folder, still an allowed kind. Otherwise null. */
  async resolve(id: string): Promise<string | null> {
    if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) return null;
    const t = this.tracks.find((x) => x.id === id);
    if (!t || !this.root) return null;
    const allowed = this.o.extensions().map((e) => e.toLowerCase().replace(/^\./, ""));
    if (!allowed.includes(t.ext)) return null;
    return this.inside(join(this.root, t.rel));
  }

  private async inside(path: string): Promise<string | null> {
    try {
      const info = await lstat(path);
      if (!info.isFile() || info.isSymbolicLink()) return null;
      const real = await realpath(path);
      return real.startsWith(this.root + sep) ? path : null;
    } catch {
      return null;
    }
  }

  /** A cover picture: one next to the track (folder, cover, front or album, as jpg or png), or one inside the file. At most 3 MB. */
  async cover(id: string): Promise<{ mime: string; data: Buffer } | null> {
    if (typeof id !== "string" || !/^[0-9a-f]{16}$/.test(id)) return null;
    const t = this.tracks.find((x) => x.id === id);
    if (!t || !this.root) return null;
    if (t.coverFile) {
      const path = await this.inside(join(this.root, t.coverFile));
      if (path) {
        try {
          if ((await stat(path)).size <= MAX_COVER_BYTES) return { mime: COVER_EXT[extname(path).slice(1).toLowerCase()]!, data: await readFile(path) };
        } catch {
          /* fall through */
        }
      }
    }
    if (t.embedded) {
      const path = await this.inside(join(this.root, t.rel));
      if (path) {
        try {
          const pic = (await parseFile(path)).common.picture?.[0];
          if (pic && pic.data.length <= MAX_COVER_BYTES) return { mime: pic.format.startsWith("image/") ? pic.format : "image/jpeg", data: Buffer.from(pic.data) };
        } catch {
          /* no picture */
        }
      }
    }
    return null;
  }
}
