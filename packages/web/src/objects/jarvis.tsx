import { jarvisProblem, type JarvisNode } from "@friend/protocol";
import { Suspense, lazy } from "react";

type Props = Record<string, unknown>;

// the component library is a separate piece of the page: it is fetched only when the assistant draws with it
const Tree = lazy(() => import("./jarvisTree"));

/** What the assistant drew with the Jarvis HUD components: a tree of data that is checked again here, never code. */
export function Jarvis({ props }: { props: Props }) {
  const problem = jarvisProblem(props);
  if (problem) return <p className="obj-empty">{problem}</p>;
  const title = typeof props.title === "string" ? props.title : "";
  return (
    <div className="obj-jarvis">
      {title && <h3 className="obj-title">{title}</h3>}
      <Suspense fallback={<p className="obj-empty">Loading…</p>}>
        <Tree node={props.ui as JarvisNode} />
      </Suspense>
    </div>
  );
}