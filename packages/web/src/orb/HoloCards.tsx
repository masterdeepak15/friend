import type { HoloPanelProps } from "./HoloPanel";

/** Cards on one page of the glass panel: two columns of three. */
export const PAGE_SIZE = 6;

export interface HoloAction {
  label: string;
  onClick: () => void;
  kind?: "primary" | "danger";
  disabled?: boolean;
}

export interface HoloCard {
  key: string;
  integrationId?: string;
  name: string;
  /** The coloured word at the top right: how it is doing. */
  badge?: "on" | "off" | "warn" | "error";
  badgeText?: string;
  /** A quiet line under the name (a version, how many tools). */
  meta?: string;
  note: string;
  noteClass: "auth-note" | "auth-error";
  actions: HoloAction[];
}

export interface HoloTab<T extends string> {
  id: T;
  label: string;
  count: number;
}

/** The page the owner is on, never past the last one (removing the last card of a page goes back one). */
export function paginate<T>(items: T[], pageIdx: number): { here: T[]; at: number; pages: number } {
  const pages = Math.max(1, Math.ceil(items.length / PAGE_SIZE));
  const at = Math.min(pageIdx, pages - 1);
  return { here: items.slice(at * PAGE_SIZE, at * PAGE_SIZE + PAGE_SIZE), at, pages };
}

/** The paging arrows for the panel, or nothing when everything fits on one page. */
export function pagingFor(at: number, pages: number, go: (to: number) => void): HoloPanelProps["page"] | undefined {
  return pages > 1 ? { index: at, total: pages, onPrev: () => go((at + pages - 1) % pages), onNext: () => go((at + 1) % pages) } : undefined;
}

/** Tabs and a grid of cards. The page of cards to show is chosen by the caller (see `paginate`). */
export function HoloCardList<T extends string>({ tabs, active, onTab, cards, empty, ready = true }: { tabs: HoloTab<T>[]; active: T; onTab: (id: T) => void; cards: HoloCard[]; empty: string; ready?: boolean }) {
  return (
    <>
      <div className="holo-tabs" role="tablist" aria-label="Sections">
        {tabs.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={active === t.id} className={`holo-tab${active === t.id ? " on" : ""}`} onClick={() => onTab(t.id)}>
            {t.label} <small>{t.count}</small>
          </button>
        ))}
      </div>
      {ready && cards.length === 0 && <p className="auth-note">{empty}</p>}
      <ul className="holo-cards">
        {cards.map((e) => (
          <li key={e.key} className="holo-card" {...(e.integrationId ? { "data-integration": e.integrationId } : {})}>
            <div className="holo-card-head">
              <strong>{e.name}</strong>
              {e.badge && <span className={`holo-badge ${e.badge}`}>{e.badgeText}</span>}
            </div>
            {e.meta && <small className="holo-version">{e.meta}</small>}
            <div className={`holo-card-note ${e.noteClass}`}>{e.note}</div>
            <div className="holo-card-actions">
              {e.actions.map((a) => (
                <button key={a.label} type="button" className={`holo-btn sm${a.kind === "primary" ? " go" : a.kind === "danger" ? " warn" : ""}`} disabled={a.disabled} onClick={a.onClick}>
                  {a.label}
                </button>
              ))}
            </div>
          </li>
        ))}
      </ul>
    </>
  );
}
