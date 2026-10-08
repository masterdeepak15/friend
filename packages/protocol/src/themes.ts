import type { PresenceStyle } from "./stage";

export interface Theme {
  id: string;
  name: string;
  style: PresenceStyle;
  /** #rrggbb */
  accent: string;
  intensity: number;
}

/** Ready-made looks for the voice presence: one choice sets the style, colour and brightness together. */
export const THEMES: Theme[] = [
  { id: "aurora", name: "Aurora", style: "sphere", accent: "#3fd8ff", intensity: 0.6 },
  { id: "ocean", name: "Ocean", style: "sphere", accent: "#2b7bff", intensity: 0.6 },
  { id: "ember", name: "Ember", style: "orb", accent: "#ff9b3d", intensity: 0.7 },
  { id: "violet", name: "Violet storm", style: "orb", accent: "#a066ff", intensity: 0.8 },
  { id: "matrix", name: "Matrix", style: "ring", accent: "#3dff8c", intensity: 0.6 },
  { id: "rose", name: "Rose", style: "ring", accent: "#ff6fae", intensity: 0.7 },
  { id: "ghost", name: "Ghost", style: "sphere", accent: "#e8f4ff", intensity: 0.4 },
];
