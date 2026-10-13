import type { IconName } from "./radialModel";

/** Simple line icons on a 24 by 24 grid, drawn in the colour of the text around them. */
const PATHS: Record<IconName, string> = {
  mic: "M12 3a3 3 0 0 1 3 3v5a3 3 0 0 1-6 0V6a3 3 0 0 1 3-3zM6 11a6 6 0 0 0 12 0M12 17v4M9 21h6",
  hands: "M3 12h2M7 8v8M11 4v16M15 8v8M19 10v4",
  voiceprint: "M12 4a8 8 0 0 0-8 8M12 8a4 4 0 0 0-4 4v2M12 12v6M16 12a4 4 0 0 0-4-4M20 12a8 8 0 0 0-8-8M16 16v2",
  family: "M8 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM2 20c0-3 2.5-5 6-5s6 2 6 5M17 10a2.5 2.5 0 1 0 0-5M16 15c3 0 6 1.5 6 5",
  mute: "M4 9v6h4l5 4V5L8 9zM17 9l4 6M21 9l-4 6",
  screen: "M3 5h18v11H3zM8 20h8M12 16v4",
  camera: "M4 8h4l2-3h4l2 3h4v11H4zM12 17a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7z",
  chat: "M4 5h16v11H9l-5 4z",
  calendar: "M4 6h16v14H4zM4 10h16M8 3v4M16 3v4",
  music: "M9 18V6l10-2v12M9 18a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0zM19 16a2.5 2.5 0 1 1-5 0 2.5 2.5 0 0 1 5 0z",
  launch: "M12 3c3 2 5 5 5 9l-3 3h-4l-3-3c0-4 2-7 5-9zM9 18l-3 3M15 18l3 3",
  eye: "M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z",
  gear: "M12 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6zM12 3v3M12 18v3M3 12h3M18 12h3M5.6 5.6l2.1 2.1M16.3 16.3l2.1 2.1M18.4 5.6l-2.1 2.1M7.7 16.3l-2.1 2.1",
  brain: "M7 7h10v10H7zM10 10h4v4h-4zM9 3v4M15 3v4M9 17v4M15 17v4M3 9h4M3 15h4M17 9h4M17 15h4",
  speaker: "M4 9v6h4l5 4V5L8 9zM16 9a4 4 0 0 1 0 6M18.5 6.5a8 8 0 0 1 0 11",
  sparkle: "M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2z",
  shield: "M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z",
  chart: "M4 19V5M4 19h16M8 15l4-4 3 3 5-6",
  grid: "M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z",
  lock: "M6 11h12v9H6zM8 11V8a4 4 0 0 1 8 0v3",
  plug: "M9 3v5M15 3v5M6 8h12v3a6 6 0 0 1-12 0zM12 17v4",
  link: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  user: "M12 12a4 4 0 1 0 0-8 4 4 0 0 0 0 8zM4 21c0-4 3.5-6 8-6s8 2 8 6",
  list: "M5 6h14M5 12h14M5 18h14",
  logout: "M10 4H4v16h6M15 8l4 4-4 4M19 12H9",
  alert: "M12 3l10 18H2zM12 10v5M12 18v.01",
};

/** An icon centred on (x, y) inside an SVG. */
export function Icon({ name, x, y, size = 20 }: { name: IconName; x: number; y: number; size?: number }) {
  return (
    <g className="orb-icon" transform={`translate(${x - size / 2} ${y - size / 2}) scale(${size / 24})`} fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={PATHS[name]} />
    </g>
  );
}
