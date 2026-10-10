import { useMemo, useState, type ReactNode } from "react";
import { sanitizeMarkdown } from "../stage/sanitize";
import { Chart, Gauge, Graph, Timeline } from "./charts";
import { Checklist, Countdown, Gallery, Img, Kv, Markdown, Pdf, Progress, Video } from "./more";
import { Sandbox } from "./sandbox";

type Props = Record<string, unknown>;

const str = (v: unknown): string => (typeof v === "string" ? v : typeof v === "number" ? String(v) : "");
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

export function Card({ props }: { props: Props }) {
  const html = useMemo(() => sanitizeMarkdown(str(props.text)), [props.text]);
  return (
    <>
      {str(props.title) && <h3 className="obj-title">{str(props.title)}</h3>}
      <div className="obj-md" dangerouslySetInnerHTML={{ __html: html }} />
    </>
  );
}

export function Stat({ props }: { props: Props }) {
  return (
    <div className="obj-stat">
      <span className="obj-label">{str(props.label)}</span>
      <span className="obj-value">
        <span>{str(props.value)}</span>
        {str(props.unit) && <small>{str(props.unit)}</small>}
      </span>
      {str(props.delta) && <span className="obj-delta">{str(props.delta)}</span>}
    </div>
  );
}

export function List({ props }: { props: Props }) {
  return (
    <>
      {str(props.title) && <h3 className="obj-title">{str(props.title)}</h3>}
      <ul className="obj-list">
        {arr(props.items).map((it, i) => {
          const item = typeof it === "object" && it !== null ? (it as Props) : { text: it };
          return (
            <li key={i} className={item.done ? "done" : undefined}>
              {str(item.text)}
            </li>
          );
        })}
      </ul>
    </>
  );
}

export function Table({ props }: { props: Props }) {
  const columns = arr(props.columns);
  const rows = arr(props.rows);
  return (
    <>
      {str(props.title) && <h3 className="obj-title">{str(props.title)}</h3>}
      <div className="obj-table-wrap">
        <table className="obj-table">
          <thead>
            <tr>
              {columns.map((c, i) => (
                <th key={i}>{str(c)}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                {arr(r).map((cell, j) => (
                  <td key={j}>{str(cell)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

export function Code({ props }: { props: Props }) {
  return (
    <>
      {str(props.title) && <h3 className="obj-title">{str(props.title)}</h3>}
      <pre className="obj-code" data-lang={str(props.language)}>
        <code>{str(props.code)}</code>
      </pre>
    </>
  );
}

/** Parts that may sit inside a group or tabs: any object except those that hold or run other things. */
function Part({ part }: { part: unknown }) {
  const p = typeof part === "object" && part !== null ? (part as { type?: unknown; props?: unknown }) : {};
  const type = typeof p.type === "string" ? p.type : "";
  if (type === "group" || type === "tabs" || type === "sandbox") return null;
  const View = CATALOG[type as keyof typeof CATALOG] as ((a: { props: Props }) => ReactNode) | undefined;
  if (!View) return null;
  return (
    <div className={`obj-part obj-part-${type}`}>
      <View props={typeof p.props === "object" && p.props !== null ? (p.props as Props) : {}} />
    </div>
  );
}

/** Several small objects in one: a dashboard. */
export function Group({ props }: { props: Props }) {
  const layout = props.layout === "row" || props.layout === "column" ? props.layout : "grid";
  return (
    <>
      {str(props.title) && <h3 className="obj-title">{str(props.title)}</h3>}
      <div className={`obj-group obj-group-${layout}`}>
        {arr(props.items).map((it, i) => (
          <Part key={i} part={it} />
        ))}
      </div>
    </>
  );
}

/** Several views of one subject in one object. */
export function Tabs({ props }: { props: Props }) {
  const tabs = arr(props.tabs).map((t) => (typeof t === "object" && t !== null ? (t as { title?: unknown; type?: unknown; props?: unknown }) : {}));
  const [at, setAt] = useState(0);
  const i = Math.min(at, Math.max(0, tabs.length - 1));
  return (
    <>
      {str(props.title) && <h3 className="obj-title">{str(props.title)}</h3>}
      <div className="obj-tabs" role="tablist">
        {tabs.map((t, n) => (
          <button key={n} type="button" role="tab" aria-selected={n === i} className={n === i ? "on" : undefined} onClick={() => setAt(n)}>
            {str(t.title) || `Tab ${n + 1}`}
          </button>
        ))}
      </div>
      {tabs[i] && <Part part={tabs[i]} />}
    </>
  );
}

export const CATALOG = {
  card: Card,
  stat: Stat,
  list: List,
  table: Table,
  code: Code,
  chart: Chart,
  gauge: Gauge,
  timeline: Timeline,
  graph: Graph,
  sandbox: Sandbox,
  markdown: Markdown,
  image: Img,
  video: Video,
  pdf: Pdf,
  gallery: Gallery,
  group: Group,
  tabs: Tabs,
  progress: Progress,
  checklist: Checklist,
  countdown: Countdown,
  kv: Kv,
} as const;
