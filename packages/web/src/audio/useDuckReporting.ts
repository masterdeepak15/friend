import { useEffect, useRef } from "react";

/** After listening or speaking ends, wait this long before saying so: a reply is spoken sentence by sentence, and the sound should not jump up between them. */
export const RELEASE_MS = 900;

/**
 * Tells the server whether this screen is listening to the owner or Friend is speaking on it, so music and video can be turned
 * down for as long as that lasts. It lets go when the screen goes away.
 */
export function useDuckReporting(mode: string, send: (m: { type: "audio.activity"; active: boolean }) => void): void {
  const sendRef = useRef(send);
  sendRef.current = send;
  const told = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    const active = mode === "listening" || mode === "speaking";
    if (timer.current) clearTimeout(timer.current);
    timer.current = null;
    if (active) {
      if (!told.current) {
        told.current = true;
        sendRef.current({ type: "audio.activity", active: true });
      }
    } else if (told.current) {
      timer.current = setTimeout(() => {
        timer.current = null;
        told.current = false;
        sendRef.current({ type: "audio.activity", active: false });
      }, RELEASE_MS);
    }
  }, [mode]);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
      if (told.current) {
        told.current = false;
        sendRef.current({ type: "audio.activity", active: false });
      }
    },
    [],
  );
}
