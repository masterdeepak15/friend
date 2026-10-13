import { polar } from "./radialModel";

export type OrbState = "idle" | "menu-open" | "hover" | "busy";

/** The orb sits at the middle of its SVG (0, 0) and is about 116 px wide. */
export const ORB_R = 58;

/** A piece of a circle drawn as a stroked path, so it can be placed by angle (clockwise from the top). */
const arcStroke = (r: number, a0: number, a1: number): string => {
  const p = (a: number) => {
    const { x, y } = polar(0, 0, r, a);
    return `${x.toFixed(2)} ${y.toFixed(2)}`;
  };
  return `M ${p(a0)} A ${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${p(a1)}`;
};

export interface OrbProps {
  /** The assistant's name, shown in the middle in capital letters. */
  name: string;
  /** The words under the name: MARK II, SELECT, the item under the pointer, LISTENING, BUSY. */
  caption: string;
  state: OrbState;
  onClick: () => void;
}

/** The centre button: dark glass, a glowing ring, ticks, an orange gauge arc at the top left and a grey segmented ring below. */
export function Orb({ name, caption, state, onClick }: OrbProps) {
  const shown = (name.trim() || "Friend").toUpperCase();
  const size = Math.max(9, Math.min(15, (15 * 6) / Math.max(shown.length, 6)));
  return (
    <g
      className={`orb-core orb-${state}`}
      role="button"
      tabIndex={0}
      aria-label={state === "menu-open" || state === "hover" ? "Close the menu" : "Open the menu"}
      onClick={onClick}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          e.stopPropagation(); // the page's own key handling must not also act on it
          onClick();
        }
      }}
    >
      <circle className="orb-halo" r={ORB_R + 4} />
      <circle className="orb-disc" r={52} fill="url(#orb-disc)" />
      <circle className="orb-ticks" r={55} />
      <circle className="orb-ring" r={46} />
      <path className="orb-gauge" d={arcStroke(50, -160, -100)} />
      <path className="orb-segments" d={arcStroke(50, 110, 250)} />
      <text className="orb-name" y={-1} fontSize={size} textAnchor="middle">
        {shown}
      </text>
      <text className="orb-caption" y={14} textAnchor="middle">
        {caption}
      </text>
    </g>
  );
}
