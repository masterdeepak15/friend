import { useEffect, useState } from "react";

const QUERY = "(pointer: coarse)";

/** True on a phone or tablet (the main pointer is a finger), where there is no keyboard for Space or Esc. */
export function useCoarsePointer(): boolean {
  const read = () => typeof matchMedia === "function" && matchMedia(QUERY).matches;
  const [coarse, setCoarse] = useState(read);
  useEffect(() => {
    if (typeof matchMedia !== "function") return;
    const mq = matchMedia(QUERY);
    const on = () => setCoarse(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  return coarse;
}
