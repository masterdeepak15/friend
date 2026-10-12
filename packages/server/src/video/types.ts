/** What Friend found of one helper program on this PC. */
export interface HelperStatus {
  found: boolean;
  version?: string;
  /** The name or path that worked, for starting it. */
  path?: string;
  /** One sentence on how to install it, when it is missing. */
  install?: string;
}

/** The three programs web video uses (see docs/guides/web-video.md). */
export interface VideoStatus {
  ytdlp: HelperStatus;
  ffmpeg: HelperStatus;
  mpv: HelperStatus;
  /** How Friend's own download of the programs is going, when it has been asked to get them. */
  setup?: { busy: boolean; message: string | null; error: string | null };
}
