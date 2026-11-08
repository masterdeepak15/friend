import { chipOf, type StageObject } from "@friend/protocol";

const safeChip = (o: StageObject): { label: string; value?: string } => {
  try {
    return chipOf(o);
  } catch {
    return { label: o.id.slice(0, 24) };
  }
};

/** The things put away, as small chips along the top. A tap brings one back as a card. */
export function ChipStrip({ chips, onRestore }: { chips: StageObject[]; onRestore: (id: string) => void }) {
  if (chips.length === 0) return null;
  return (
    <nav className="chip-strip" aria-label="Put away">
      {chips.map((o) => {
        const { label, value } = safeChip(o);
        return (
          <button key={o.id} type="button" className="chip" data-chip={o.id} aria-label={`Show ${label}`} title={`Show ${label}`} onClick={() => onRestore(o.id)}>
            <span className="chip-label">{label}</span>
            {value !== undefined && <span className="chip-value">{value}</span>}
          </button>
        );
      })}
    </nav>
  );
}
