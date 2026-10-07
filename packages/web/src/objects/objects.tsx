import { useMemo } from "react";
import { sanitizeMarkdown } from "../stage/sanitize";

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

export const CATALOG = { card: Card, stat: Stat, list: List, table: Table, code: Code } as const;
