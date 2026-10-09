import type { ClientMsg, ScreenInfo } from "@friend/protocol";
import { useEffect, useRef } from "react";
import type { Connection } from "../store";

/** Below this width everything stacks in one column (the same line the stage uses). */
export const PHONE_MAX_WIDTH = 599;

/** What kind of screen this is, from its size and whether it is used with a finger. */
export function classifyScreen(width: number, height: number, touch: boolean): ScreenInfo {
  const w = Math.max(100, Math.round(width));
  const h = Math.max(100, Math.round(height));
  const kind = w <= PHONE_MAX_WIDTH ? "phone" : touch || w < 1024 ? "tablet" : "desktop";
  return { width: w, height: h, kind, orientation: h > w ? "portrait" : "landscape", touch };
}

const isTouch = (): boolean => typeof matchMedia === "function" && matchMedia("(pointer: coarse)").matches;

export function readScreen(): ScreenInfo {
  return classifyScreen(window.innerWidth, window.innerHeight, isTouch());
}

const same = (a: ScreenInfo | null, b: ScreenInfo): boolean => !!a && a.width === b.width && a.height === b.height && a.kind === b.kind && a.orientation === b.orientation && a.touch === b.touch;

/**
 * Tells the server what this screen is, when the connection opens and again (after a short pause) whenever the window is
 * resized or turned, so the assistant lays things out for the screen it is really drawing on.
 */
export function useScreenReport(send: (m: ClientMsg) => void, connection: Connection): void {
  const last = useRef<ScreenInfo | null>(null);
  const sendRef = useRef(send);
  sendRef.current = send;

  useEffect(() => {
    if (connection !== "open") {
      last.current = null; // a new connection starts from nothing: say it again
      return;
    }
    const report = () => {
      const now = readScreen();
      if (same(last.current, now)) return;
      last.current = now;
      sendRef.current({ type: "ui.screen", ...now });
    };
    report();
    let timer: ReturnType<typeof setTimeout> | null = null;
    const later = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(report, 400);
    };
    window.addEventListener("resize", later);
    window.addEventListener("orientationchange", later);
    return () => {
      if (timer) clearTimeout(timer);
      window.removeEventListener("resize", later);
      window.removeEventListener("orientationchange", later);
    };
  }, [connection]);
}
