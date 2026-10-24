export interface Measured {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** How big the content is (what the box would have to be to show all of it). */
  scrollW: number;
  scrollH: number;
  /** Whether anything is drawn in it (text, a picture or a chart). */
  drawn: boolean;
}
export interface Box {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}
export interface Screen {
  view: { w: number; h: number };
  objects: Measured[];
  /** The screen's own instruments (system, voice, radar...): what an object should not cover. */
  hud: Box[];
}

const MAX_LINES = 12;
const clip = (s: string) => (s.length > 200 ? `${s.slice(0, 199)}…` : s);
/** More than this share of the smaller box covered counts as sitting on top of it. */
const COVER = 0.2;
const SLACK = 4;

const overlapShare = (a: Box, b: Box): number => {
  const w = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  if (w <= 0 || h <= 0) return 0;
  return (w * h) / Math.max(1, Math.min(a.w * a.h, b.w * b.h));
};

/** What is wrong with the screen after something was drawn, in short sentences the assistant can act on; one line saying so when nothing is. */
export function analyzeScreen(s: Screen): string[] {
  if (s.objects.length === 0) return ["No objects are on the screen."];
  const out: string[] = [];
  const r = (n: number) => Math.round(n);
  for (const o of s.objects) {
    if (!o.drawn) out.push(`${o.id}: nothing is drawn in it (an empty box). Hide it, or check its props.`);
    if (o.scrollH - o.h > SLACK || o.scrollW - o.w > SLACK) out.push(`${o.id}: its content is cut off: it needs about ${r(Math.max(o.scrollW, o.w))}x${r(Math.max(o.scrollH, o.h))} px and the box is ${r(o.w)}x${r(o.h)} px. Make the box bigger or the content smaller.`);
    const off = Math.max(0, -o.x, -o.y, o.x + o.w - s.view.w, o.y + o.h - s.view.h);
    if (off > SLACK) out.push(`${o.id}: ${r(off)} px of it is outside the screen. Move it inside.`);
  }
  for (let i = 0; i < s.objects.length; i++) {
    for (let j = i + 1; j < s.objects.length; j++) {
      if (overlapShare(s.objects[i]!, s.objects[j]!) > COVER) out.push(`${s.objects[i]!.id} and ${s.objects[j]!.id} overlap. Move one of them.`);
    }
    for (const h of s.hud) if (overlapShare(s.objects[i]!, h) > COVER) out.push(`${s.objects[i]!.id} covers the ${h.id} instrument. Move it to a free place.`);
  }
  if (out.length === 0) return [`All ${s.objects.length} objects are fully visible, nothing overlaps.`];
  const lines = out.map(clip);
  return lines.length > MAX_LINES ? [...lines.slice(0, MAX_LINES - 1), `…and ${lines.length - (MAX_LINES - 1)} more problems of the same kind.`] : lines;
}

/** Measures the screen as it is now: the objects the assistant put up, and the instruments of the HUD. */
export function measureScreen(doc: Document, win: { innerWidth: number; innerHeight: number }): Screen {
  const box = (el: Element) => {
    const b = el.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  };
  const objects = [...doc.querySelectorAll<HTMLElement>("[data-object]")]
    .filter((el) => !el.classList.contains("leaving"))
    .map((el): Measured => ({ id: el.dataset.object ?? "?", ...box(el), scrollW: el.scrollWidth, scrollH: el.scrollHeight, drawn: (el.querySelector(".obj-jarvis, .obj-empty") ? !el.querySelector(".obj-empty") : true) && ((el.textContent ?? "").replace(/[×📌\s]/g, "").length > 0 || !!el.querySelector("svg, canvas, img, video, iframe")) }));
  const hud = [...doc.querySelectorAll<HTMLElement>(".orbital [data-widget]")].map((el): Box => ({ id: el.dataset.widget ?? "?", ...box(el) }));
  return { view: { w: win.innerWidth, h: win.innerHeight }, objects, hud };
}