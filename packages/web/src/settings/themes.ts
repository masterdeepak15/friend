import type { Look, PresenceStyleName } from "./settingsApi";

export interface Theme {
  id: string;
  name: string;
  style: PresenceStyleName;
  accent: string;
  intensity: number;
}

/** Ready-made looks: one click sets the style, colour and brightness together. Everything can still be adjusted afterwards. */
export const THEMES: Theme[] = [
  { id: "aurora", name: "Aurora", style: "sphere", accent: "#3fd8ff", intensity: 0.6 },
  { id: "ocean", name: "Ocean", style: "sphere", accent: "#2b7bff", intensity: 0.6 },
  { id: "ember", name: "Ember", style: "orb", accent: "#ff9b3d", intensity: 0.7 },
  { id: "violet", name: "Violet storm", style: "orb", accent: "#a066ff", intensity: 0.8 },
  { id: "matrix", name: "Matrix", style: "ring", accent: "#3dff8c", intensity: 0.6 },
  { id: "rose", name: "Rose", style: "ring", accent: "#ff6fae", intensity: 0.7 },
  { id: "ghost", name: "Ghost", style: "sphere", accent: "#e8f4ff", intensity: 0.4 },
];

/** Quick colour choices; any other colour can be picked with the colour box. */
export const SWATCHES = ["#3fd8ff", "#2b7bff", "#a066ff", "#ff6fae", "#ff5a5a", "#ff9b3d", "#ffd23d", "#3dff8c", "#e8f4ff"];

export const STYLES: { id: PresenceStyleName; name: string; note: string }[] = [
  { id: "sphere", name: "Sphere", note: "A cloud of particles" },
  { id: "orb", name: "Orb", note: "A glowing plasma ball" },
  { id: "ring", name: "Ring", note: "Radial bars, like a voice meter" },
];

export const isTheme = (look: Pick<Look, "style" | "accent" | "intensity">, t: Theme): boolean =>
  look.style === t.style && look.accent.toLowerCase() === t.accent && Math.abs(look.intensity - t.intensity) < 0.005;
