import type { StageObject } from "@friend/protocol";
import { useEffect, useRef, useState } from "react";

export interface GhostEntry {
  object: StageObject;
  leaving: boolean;
}

/** Keeps objects that were removed in the list (marked leaving) so they can animate out. */
export function mergeGhosts(prev: GhostEntry[], current: StageObject[]): GhostEntry[] {
  const byId = new Map(current.map((o) => [o.id, o]));
  const out: GhostEntry[] = [];
  const seen = new Set<string>();
  for (const e of prev) {
    if (seen.has(e.object.id)) continue;
    seen.add(e.object.id);
    const now = byId.get(e.object.id);
    out.push(now ? { object: now, leaving: false } : { object: e.object, leaving: true });
  }
  for (const o of current) {
    if (seen.has(o.id)) continue;
    seen.add(o.id);
    out.push({ object: o, leaving: false });
  }
  return out;
}

/** Objects to render: the live ones plus any that left less than `ms` ago. `ms <= 0` disables the exit animation. */
export function useGhosts(objects: StageObject[], ms: number): GhostEntry[] {
  const [list, setList] = useState<GhostEntry[]>(() => objects.map((object) => ({ object, leaving: false })));
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());

  useEffect(() => {
    setList((prev) => {
      const next = mergeGhosts(prev, objects);
      const wasLeaving = new Set(prev.filter((e) => e.leaving).map((e) => e.object.id));
      for (const e of next) {
        const t = timers.current.get(e.object.id);
        if (!e.leaving) {
          if (t) clearTimeout(t);
          timers.current.delete(e.object.id);
        } else if (!wasLeaving.has(e.object.id) && !t) {
          const id = e.object.id;
          timers.current.set(
            id,
            setTimeout(() => {
              timers.current.delete(id);
              setList((l) => l.filter((x) => !(x.object.id === id && x.leaving)));
            }, Math.max(ms, 0)),
          );
        }
      }
      return ms <= 0 ? next.filter((e) => !e.leaving) : next;
    });
  }, [objects, ms]);

  useEffect(
    () => () => {
      for (const t of timers.current.values()) clearTimeout(t);
      timers.current.clear();
    },
    [],
  );

  return list;
}
