import type { KeyboardEvent } from "react";
import { Icon } from "./icons";
import { arcPath, fan, layoutArcs, polar, type MenuState, type OrbCategory, type OrbItem } from "./radialModel";

/** Radii of the two rings around the orb, in the SVG's own units. */
export const RING1 = [72, 128] as const;
export const RING2 = [138, 176] as const;
const LABEL_R = 186;

export interface RadialMenuProps {
  categories: OrbCategory[];
  state: MenuState;
  onCategory: (id: string) => void;
  onHover: (id: string | null) => void;
  onPick: (item: OrbItem) => void;
}

const mid = (r: readonly [number, number]) => (r[0] + r[1]) / 2;

/** Where a label goes beside an arc, and which way the text runs from that point. */
function labelAt(r: number, deg: number): { x: number; y: number; anchor: "start" | "middle" | "end"; dy: string } {
  const { x, y } = polar(0, 0, r, deg);
  const s = Math.sin((deg * Math.PI) / 180);
  const c = Math.cos((deg * Math.PI) / 180);
  const anchor = s > 0.35 ? "start" : s < -0.35 ? "end" : "middle";
  return { x: x + (anchor === "start" ? 4 : anchor === "end" ? -4 : 0), y, anchor, dy: Math.abs(s) > 0.35 ? "0.35em" : c > 0 ? "-0.4em" : "1em" };
}

/** Moves the focus to the next or previous arc of the same ring (arrow keys), and activates on Enter or Space. */
function arcKeys(e: KeyboardEvent<SVGGElement>, ring: number, activate: () => void) {
  if (e.key === "Enter" || e.key === " ") {
    e.preventDefault();
    e.stopPropagation(); // the page's own key handling must not also act on it
    return activate();
  }
  const step = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
  if (!step) return;
  e.preventDefault();
  const all = [...(e.currentTarget.closest("svg")?.querySelectorAll<SVGGElement>(`[data-ring="${ring}"]`) ?? [])];
  const at = all.indexOf(e.currentTarget);
  all[(at + step + all.length) % all.length]?.focus();
}

/** The two rings of arcs: the categories, and (for the one that is open) its items fanned out beyond it. */
export function RadialMenu({ categories, state, onCategory, onHover, onPick }: RadialMenuProps) {
  const ring1 = layoutArcs(categories.length);
  const open = categories.findIndex((c) => c.id === state.category);
  const parent = open >= 0 ? categories[open]! : null;
  const ring2 = parent ? fan(ring1[open]!.mid, parent.items.length) : [];
  const hover = (id: string) => ({ onPointerEnter: () => onHover(id), onPointerLeave: () => onHover(null), onFocus: () => onHover(id), onBlur: () => onHover(null) });

  return (
    <g className="orb-rings">
      <g className="orb-ring1" key="ring1">
        {categories.map((c, i) => {
          const a = ring1[i]!;
          const p = polar(0, 0, mid(RING1), a.mid);
          const lab = labelAt(RING1[1] + 8, a.mid);
          const on = c.id === state.category;
          return (
            <g
              key={c.id}
              className={`orb-arc${on ? " is-open" : ""}${state.hover === c.id ? " is-hover" : ""}`}
              data-ring={1}
              data-id={c.id}
              role="button"
              tabIndex={0}
              aria-label={c.label}
              aria-expanded={on}
              style={{ animationDelay: `${i * 30}ms` }}
              onClick={() => onCategory(c.id)}
              onKeyDown={(e) => arcKeys(e, 1, () => onCategory(c.id))}
              {...hover(c.id)}
            >
              <path d={arcPath(0, 0, RING1[0], RING1[1], a.start, a.end)} />
              <Icon name={c.icon} x={p.x} y={p.y} size={24} />
              {!parent && (
                <text className="orb-arc-label" x={lab.x} y={lab.y} dy={lab.dy} textAnchor={lab.anchor}>
                  {c.label}
                </text>
              )}
            </g>
          );
        })}
      </g>
      {parent && (
        <g className="orb-ring2" key={`ring2-${parent.id}`}>
          {parent.items.map((item, i) => {
            const a = ring2[i]!;
            const p = polar(0, 0, mid(RING2), a.mid);
            const lab = labelAt(LABEL_R, a.mid);
            return (
              <g
                key={item.id}
                className={`orb-arc orb-sub${item.on ? " is-on" : ""}${item.danger ? " is-danger" : ""}${state.hover === item.id ? " is-hover" : ""}`}
                data-ring={2}
                data-id={item.id}
                role="button"
                tabIndex={0}
                aria-label={item.label}
                {...(item.kind === "toggle" ? { "aria-pressed": !!item.on } : {})}
                style={{ animationDelay: `${i * 25}ms` }}
                onClick={() => onPick(item)}
                onKeyDown={(e) => arcKeys(e, 2, () => onPick(item))}
                {...hover(item.id)}
              >
                <path d={arcPath(0, 0, RING2[0], RING2[1], a.start, a.end)} />
                <Icon name={item.icon} x={p.x} y={p.y} size={17} />
                <text className="orb-arc-label" x={lab.x} y={lab.y} dy={lab.dy} textAnchor={lab.anchor}>
                  {item.label}
                  {item.kind === "toggle" ? (item.on ? " · ON" : " · OFF") : ""}
                </text>
              </g>
            );
          })}
        </g>
      )}
    </g>
  );
}
