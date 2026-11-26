import type { DeckControl, DeckItem, DeckView as View } from "@friend/protocol";
import { useEffect, useRef, type ReactNode } from "react";
import { CATALOG } from "../objects/objects";
import "./deck.css";

const reducedMotion = (): boolean => {
  try {
    return typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  } catch {
    return false;
  }
};

/** How an item comes in when the assistant gave no animation of its own. */
const DEFAULT_ANIMATION: Record<string, string> = { text: "slide-up", chart: "draw", graph: "draw" };

function Content({ item }: { item: DeckItem }): ReactNode {
  if (item.kind === "text") {
    const text = String(item.content.text ?? "");
    const style = item.content.style;
    if (style === "heading") return <h3 className="deck-heading">{text}</h3>;
    if (style === "quote") return <blockquote className="deck-quote">{text}</blockquote>;
    return <p className="deck-bullet">{text}</p>;
  }
  const Draw = CATALOG[item.kind] as ((a: { props: Record<string, unknown> }) => ReactNode) | undefined;
  return Draw ? <div className="deck-object"><Draw props={item.content} /></div> : null;
}

export interface DeckViewProps {
  view: View;
  onControl: (action: DeckControl) => void;
}

/** One slide of a presentation: its title, the items shown so far (the newest comes in with its animation), and the control bar. */
export function DeckView({ view, onControl }: DeckViewProps) {
  const { slide, shown, state } = view;
  const still = reducedMotion();
  // items already there when this slide first drew (a screen that joined late) do not play their entrance again
  const seen = useRef<{ key: string; ids: Set<string> } | null>(null);
  const key = `${view.deckId}:${slide.id}`;
  if (!seen.current || seen.current.key !== key) seen.current = { key, ids: new Set(slide.items.slice(0, Math.max(0, shown - 1)).map((i) => i.id)) };
  const known = seen.current.ids;
  const visible = slide.items.slice(0, shown);
  const animations = new Map(visible.map((i) => [i.id, known.has(i.id) || still ? null : (i.animation ?? DEFAULT_ANIMATION[i.kind] ?? "fade")]));
  useEffect(() => {
    for (const i of visible) known.add(i.id);
  });

  const paused = state === "paused";
  return (
    <section className={`deck deck-${slide.layout}`} data-testid="deck" aria-label={`Presentation: ${view.title}`}>
      <header className="deck-head">
        <h2 className="deck-title">{slide.title}</h2>
      </header>
      <div className="deck-items">
        {visible.map((item) => {
          const a = animations.get(item.id);
          return (
            <div key={item.id} data-item={item.id} className={`deck-item${a && a !== "none" ? ` anim-${a}` : ""}`}>
              <Content item={item} />
            </div>
          );
        })}
      </div>
      <footer className="deck-bar">
        <button type="button" aria-label="Previous slide" onClick={() => onControl("back")}>⏮</button>
        {paused ? (
          <button type="button" aria-label="Continue" onClick={() => onControl("resume")}>▶ Continue</button>
        ) : (
          <button type="button" aria-label="Pause" disabled={state === "ended"} onClick={() => onControl("pause")}>⏸</button>
        )}
        <button type="button" aria-label="Next slide" onClick={() => onControl("next")}>⏭</button>
        <span className="deck-count">{view.index + 1} / {view.total}</span>
        {paused && <span className="deck-state">Paused: ask me anything, then say continue</span>}
        {state === "ended" && <span className="deck-state">The end</span>}
        <button type="button" aria-label="Stop presentation" onClick={() => onControl("stop")}>✕</button>
      </footer>
    </section>
  );
}
