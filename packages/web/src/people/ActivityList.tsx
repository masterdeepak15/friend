import { useEffect, useRef } from "react";
import { colourOf, initials, kindLabel, markOf, type Act, type Who } from "./people";
import "./activity.css";

const time = (at: number): string => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** The mark of a person: initials on their own colour. Office workers are hexagons and crew are rounded squares, so the kind shows without reading. */
export function Avatar({ who, size = 28, live = false }: { who: Who; size?: number; live?: boolean }) {
  return (
    <span className="ac-av" data-kind={who.kind} data-live={live} style={{ width: size, height: size, fontSize: Math.round(size * 0.4), ["--ac-c" as string]: colourOf(who) }} aria-hidden>
      {initials(who.name)}
    </span>
  );
}

/** Everyone in the feed, with a light for who is at work, so a colour can be matched to a name before a line is read. */
export function Legend({ people, working = [] }: { people: Who[]; working?: string[] }) {
  return (
    <ul className="ac-legend" aria-label="Who is who">
      {people.map((w) => (
        <li key={`${w.kind}:${w.id}`} className="ac-chip" style={{ ["--ac-c" as string]: colourOf(w) }}>
          <Avatar who={w} size={18} live={working.includes(w.id)} />
          <span>{w.name}</span>
          <small>{kindLabel(w.kind)}</small>
        </li>
      ))}
    </ul>
  );
}

/**
 * A feed where every message is under the name of whoever it belongs to: a run of lines of one person is one block with the person's
 * avatar, full name, kind and role at the top, and each line has its time and what kind of line it is. The newest line is last.
 */
export function ActivityList({ items, empty = "Nothing yet", live = [], legend = true }: { items: Act[]; empty?: string; live?: string[]; legend?: boolean }) {
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current;
    if (el) el.scrollTop = el.scrollHeight; // opens at the newest line
  }, [items.length]);
  const people = [...new Map(items.map((a) => [`${a.who.kind}:${a.who.id}`, a.who])).values()];
  const blocks: { who: Who; lines: Act[] }[] = [];
  for (const a of items) {
    const last = blocks.at(-1);
    if (last && last.who.id === a.who.id && last.who.kind === a.who.kind) last.lines.push(a);
    else blocks.push({ who: a.who, lines: [a] });
  }
  return (
    <div className="ac-wrap">
      {legend && people.length > 1 && <Legend people={people} working={live} />}
      <div className="ac-list" ref={box} aria-live="polite">
        {items.length === 0 && <p className="ac-empty">{empty}</p>}
        {blocks.map((b, i) => (
          <section key={`${b.who.kind}${b.who.id}-${b.lines[0]!.at}-${i}`} className="ac-block" data-kind={b.who.kind} style={{ ["--ac-c" as string]: colourOf(b.who) }} aria-label={b.who.name}>
            <Avatar who={b.who} live={live.includes(b.who.id) && i === blocks.length - 1} />
            <div className="ac-body">
              <header className="ac-who">
                <strong>{b.who.name}</strong>
                <small>{kindLabel(b.who.kind)}</small>
                {b.who.role ? <span className="ac-role">{b.who.role}</span> : null}
              </header>
              {b.lines.map((l, j) => (
                <p key={`${l.at}-${j}`} className="ac-line" data-kind={l.kind} data-feed-line="">
                  {l.at > 0 && <time>{time(l.at)}</time>}
                  {markOf(l.kind) && <i>{markOf(l.kind)}</i>} {l.text}
                </p>
              ))}
            </div>
          </section>
        ))}
      </div>
    </div>
  );
}
