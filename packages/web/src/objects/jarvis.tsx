import { jarvisObjectProblem, jarvisTreeOf, type JarvisNode } from "@friend/protocol";
import { Suspense, lazy } from "react";

type Props = Record<string, unknown>;

// the component library is a separate piece of the page: it is fetched only when something is drawn with it
const Tree = lazy(() => import("./jarvisTree"));

/** An object whose type is a Jarvis component: it draws that component with the object's props. The props are checked again here, never code. */
export function JarvisObject({ type, props }: { type: string; props: Props }) {
  const problem = jarvisObjectProblem(type, props);
  if (problem) return <p className="obj-empty">{problem}</p>;
  return (
    <div className="obj-jarvis">
      <Suspense fallback={<p className="obj-empty">Loading…</p>}>
        <Tree node={jarvisTreeOf(type, props) as JarvisNode} />
      </Suspense>
    </div>
  );
}