import { useState } from "react";

/** One entry of a worker's wiki, from the top: folders and notes, each with how deep it is. */
export interface Outline {
  path: string;
  kind: "note" | "folder";
  title: string;
  summary: string;
  depth: number;
}

/** The outline as the server sends it (JSON text), or nothing when it is not readable. */
export function parseOutline(text: string | undefined): Outline[] | null {
  if (!text) return null;
  try {
    const v = JSON.parse(text) as unknown;
    return Array.isArray(v) ? (v as Outline[]) : null;
  } catch {
    return null;
  }
}

/**
 * A worker's wiki as a tree you can open: folders fold and unfold, a note opens when you click it. Each entry shows its title, and its
 * one-line summary when it has one, so you can see what the worker knows without reading every note.
 */
export function MemoryTreeView({ outline, open, onOpen }: { outline: Outline[]; open: string; onOpen: (path: string) => void }) {
  const [shut, setShut] = useState<Set<string>>(new Set());
  // a folder's path ends with a slash (as the server writes it); what is inside it starts with that path
  const hidden = (e: Outline): boolean => [...shut].some((f) => e.path !== f && e.path.startsWith(f.endsWith("/") ? f : `${f}/`));
  if (outline.length === 0) return <p className="cr-sub">No notes yet. They appear as the worker learns.</p>;
  return (
    <ul className="cr-tree" role="tree" aria-label="Memory">
      {outline.filter((e) => !hidden(e)).map((e) => (
        <li key={e.path} role="treeitem" aria-expanded={e.kind === "folder" ? !shut.has(e.path) : undefined} aria-selected={e.path === open} style={{ paddingLeft: e.depth * 14 }}>
          <button
            type="button"
            className="cr-node"
            data-kind={e.kind}
            data-open={e.path === open}
            title={e.summary || e.path}
            onClick={() => {
              if (e.kind === "folder") setShut((s) => { const n = new Set(s); if (n.has(e.path)) n.delete(e.path); else n.add(e.path); return n; });
              else onOpen(e.path);
            }}
          >
            <span aria-hidden>{e.kind === "folder" ? (shut.has(e.path) ? "▸" : "▾") : "·"}</span> {e.title || e.path.split("/").pop()}
            {e.summary ? <small> {e.summary}</small> : null}
          </button>
        </li>
      ))}
    </ul>
  );
}
