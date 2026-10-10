/**
 * iPhone and iPad Safari (and browsers built on it) decide how the phone's audio behaves through navigator.audioSession.
 * "playback" lets sound through even with the silent switch on, but it cannot record: opening the microphone while it is set
 * fails with "AudioSession category is not compatible with audio capture". So the microphone gets "play-and-record" for as
 * long as it is open (playback keeps working in that mode too), and "playback" is put back afterwards.
 */
type SessionType = "playback" | "play-and-record";
type AudioSessionLike = { type: string };

let capturing = 0;

function set(type: SessionType): void {
  try {
    const session = (navigator as unknown as { audioSession?: AudioSessionLike }).audioSession;
    if (session && session.type !== type) session.type = type;
  } catch {
    /* not supported here: nothing to do */
  }
}

/** Sound should play even when the silent switch is on. Does not touch an open microphone. */
export function playbackSession(): void {
  if (capturing === 0) set("playback");
}

/** The microphone is about to open. Returns what to call when it is closed. */
export function captureSession(): () => void {
  capturing++;
  set("play-and-record");
  let released = false;
  return () => {
    if (released) return;
    released = true;
    capturing = Math.max(0, capturing - 1);
    if (capturing === 0) set("playback");
  };
}
