import { jarvisObjectProblem, type JarvisNode } from "@friend/protocol";
import { Suspense, lazy, useEffect, useRef, useState, type ReactNode } from "react";

// the component library is a separate piece of the page: it is fetched only when an instrument is drawn with it
const Tree = lazy(() => import("../../objects/jarvisTree"));

/**
 * An instrument drawn with Jarvis components. While the library is on its way (the first time), or if the tree is not acceptable,
 * the plain drawing of the instrument shows instead, so the screen is never empty.
 */
export function JLive({ node, children }: { node: JarvisNode; children: ReactNode }) {
  if (jarvisObjectProblem(node.c, { ...(node.p ?? {}), ...(node.kids ? { kids: node.kids } : {}) })) return <>{children}</>;
  return (
    <div className="ob-jlive">
      <Suspense fallback={children}>
        <Tree node={node} />
      </Suspense>
    </div>
  );
}

/** The last few readings of a number, newest last, for a small trend line. A new reading is added when `stamp` changes. */
export function useRolling(value: number, stamp: unknown, size = 24): number[] {
  const [values, setValues] = useState<number[]>([]);
  const last = useRef<unknown>(undefined);
  const lastAt = useRef(0);
  useEffect(() => {
    if (last.current === stamp) return;
    last.current = stamp;
    // at most one reading a second, so a stamp that changes on every draw (the sample preview) cannot make the screen draw again and again
    const now = Date.now();
    if (now - lastAt.current < 1000) return;
    lastAt.current = now;
    setValues((v) => [...v, value].slice(-size));
  }, [value, stamp, size]);
  return values;
}
