export interface PresenceEnv {
  webgl: boolean;
  memoryGb?: number;
  reducedMotion: boolean;
}

/** 6000–12000 points scaled by device memory; 0 means "no WebGL, use the 2D fallback". */
export function pickParticleCount(env: PresenceEnv): number {
  if (!env.webgl) return 0;
  if (env.reducedMotion) return 6000;
  if (env.memoryGb === undefined) return 8000;
  if (env.memoryGb >= 8) return 12000;
  if (env.memoryGb >= 4) return 9000;
  return 6000;
}

export function detectEnv(): PresenceEnv {
  let webgl = false;
  try {
    const c = document.createElement("canvas");
    webgl = !!(c.getContext("webgl2") || c.getContext("webgl"));
  } catch {
    webgl = false;
  }
  return {
    webgl,
    memoryGb: (navigator as Navigator & { deviceMemory?: number }).deviceMemory,
    reducedMotion: typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches,
  };
}
