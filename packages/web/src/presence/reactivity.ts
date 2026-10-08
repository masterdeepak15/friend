/**
 * How strongly the presence follows the voice. The default (0.7) leaves the amplitude exactly as it is; lower is calmer
 * (never fully still), higher moves more.
 */
export const reactivityFactor = (reactivity: number): number => 0.25 + 0.75 * (Math.min(1, Math.max(0, reactivity)) / 0.7);
