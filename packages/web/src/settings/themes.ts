import type { Theme } from "@friend/protocol";
import type { Look, PresenceStyleName } from "./settingsApi";

export { THEMES, type Theme } from "@friend/protocol";

/** Quick colour choices; any other colour can be picked with the colour box. */
export const SWATCHES = ["#3fd8ff", "#2b7bff", "#a066ff", "#ff6fae", "#ff5a5a", "#ff9b3d", "#ffd23d", "#3dff8c", "#e8f4ff"];

export const STYLES: { id: PresenceStyleName; name: string; note: string }[] = [
  { id: "sphere", name: "Sphere", note: "A cloud of particles" },
  { id: "orb", name: "Orb", note: "A glowing plasma ball" },
  { id: "ring", name: "Ring", note: "Radial bars, like a voice meter" },
];

export const isTheme = (look: Pick<Look, "style" | "accent" | "intensity">, t: Theme): boolean =>
  look.style === t.style && look.accent.toLowerCase() === t.accent && Math.abs(look.intensity - t.intensity) < 0.005;
