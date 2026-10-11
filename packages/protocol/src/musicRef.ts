/** Where a track comes from. A track is addressed by a ref: `<source>:<id>`, or a bare 16-hex id for a file in the music folder. */
export const MUSIC_SOURCES = ["local", "spotify", "soundcloud", "audius"] as const;
export type MusicSourceId = (typeof MUSIC_SOURCES)[number];

const LOCAL_ID = /^[0-9a-f]{16}$/;
const SOUNDCLOUD_ID = /^[0-9]{1,20}$/;
const SERVICE_ID = /^[A-Za-z0-9_-]{1,64}$/;

export function parseRef(ref: string): { source: MusicSourceId; id: string } | null {
  if (typeof ref !== "string") return null;
  if (LOCAL_ID.test(ref)) return { source: "local", id: ref };
  const at = ref.indexOf(":");
  if (at < 1) return null;
  const source = ref.slice(0, at);
  const id = ref.slice(at + 1);
  if (!(MUSIC_SOURCES as readonly string[]).includes(source)) return null;
  if (!(source === "local" ? LOCAL_ID : source === "soundcloud" ? SOUNDCLOUD_ID : SERVICE_ID).test(id)) return null;
  return { source: source as MusicSourceId, id };
}

export const makeRef = (source: MusicSourceId, id: string): string => `${source}:${id}`;
