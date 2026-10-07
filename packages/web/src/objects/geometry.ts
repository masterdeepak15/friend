const finite = (n: number) => Number.isFinite(n);

/** Round a raw step up to 1, 2, 2.5, 5 or 10 times a power of ten. */
function niceStep(raw: number): number {
  const exp = Math.floor(Math.log10(raw));
  const f = raw / 10 ** exp;
  const nice = f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10;
  return nice * 10 ** exp;
}

export function niceScale(min: number, max: number, ticks = 5): { min: number; max: number; ticks: number[] } {
  let lo = finite(min) ? min : 0;
  let hi = finite(max) ? max : lo + 1;
  if (lo > hi) [lo, hi] = [hi, lo];
  if (lo === hi) hi = lo + (Math.abs(lo) || 1);
  const step = niceStep((hi - lo) / Math.max(1, ticks - 1));
  const nmin = Math.floor(lo / step) * step;
  const nmax = Math.ceil(hi / step) * step;
  const out: number[] = [];
  for (let v = nmin; v <= nmax + step / 2; v += step) out.push(Math.round(v * 1e9) / 1e9);
  return { min: nmin, max: nmax, ticks: out };
}

export function scaleLinear(domain: [number, number], range: [number, number]): (v: number) => number {
  const [d0, d1] = domain;
  const [r0, r1] = range;
  if (d1 === d0) return () => r0;
  return (v) => r0 + ((v - d0) / (d1 - d0)) * (r1 - r0);
}

export function linePath(points: [number, number][]): string {
  return points.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(2)} ${y.toFixed(2)}`).join(" ");
}

/** SVG arc along a circle; angles in degrees, 0 = 3 o'clock, increasing clockwise. */
export function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const pt = (a: number) => {
    const rad = (a * Math.PI) / 180;
    return `${(cx + r * Math.cos(rad)).toFixed(2)} ${(cy + r * Math.sin(rad)).toFixed(2)}`;
  };
  const large = Math.abs(a1 - a0) > 180 ? 1 : 0;
  return `M ${pt(a0)} A ${r} ${r} 0 ${large} 1 ${pt(a1)}`;
}

/** Degrees (0..240) of a gauge sweep for a value within min..max. */
export function gaugeAngle(value: number, min: number, max: number): number {
  if (!finite(value) || !finite(min) || !finite(max) || max <= min) return 0;
  return Math.min(1, Math.max(0, (value - min) / (max - min))) * 240;
}

/** Trim a segment by `r1` at its start and `r2` at its end (so edges stop at node borders). */
export function shortenSegment(
  a: { x: number; y: number },
  b: { x: number; y: number },
  r1: number,
  r2: number,
): { from: { x: number; y: number }; to: { x: number; y: number } } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len = Math.hypot(dx, dy);
  if (len === 0 || len <= r1 + r2) return { from: { ...a }, to: { ...b } };
  const ux = dx / len;
  const uy = dy / len;
  return { from: { x: a.x + ux * r1, y: a.y + uy * r1 }, to: { x: b.x - ux * r2, y: b.y - uy * r2 } };
}

/** Points evenly spaced on a circle (starting at the top), inside a w×h box. */
export function circleLayout(n: number, w: number, h: number): { x: number; y: number }[] {
  if (n <= 0) return [];
  if (n === 1) return [{ x: w / 2, y: h / 2 }];
  const r = Math.min(w, h) * 0.36;
  return Array.from({ length: n }, (_, i) => {
    const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
    return { x: w / 2 + r * Math.cos(a), y: h / 2 + r * Math.sin(a) };
  });
}
