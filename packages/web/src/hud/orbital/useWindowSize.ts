import { useEffect, useState } from "react";

/** The size of the window, kept up to date; `override` (used by tests) stands in for the real window. */
export function useWindowSize(override?: { w: number; h: number }): { w: number; h: number } {
  const read = () => ({ w: window.innerWidth, h: window.innerHeight });
  const [size, setSize] = useState(read);
  useEffect(() => {
    if (override) return;
    const on = () => setSize(read());
    window.addEventListener("resize", on);
    return () => window.removeEventListener("resize", on);
  }, [override]);
  return override ?? size;
}