import { HUD_WIDGET_IDS, type HudDensity, type HudWidgetId } from "./hud";
import { jarvisNaturalSize, jarvisObjectProblem, isJarvisType, jarvisTreeOf } from "./jarvis";
import { overlap, type Rect } from "./layout";
import type { ScreenInfo } from "./messages";
import type { StageObject } from "./stage";

/**
 * Where everything of the screen may go for each kind of screen, as boxes that never overlap, and what a chip says. Pure maths:
 * the server turns the assistant's intent (focus, beside, glance...) into positions with this, the screen draws them.
 */

const pct = (x: number, y: number, w: number, h: number): Rect => [Math.round((x / 16) * 100) / 100, Math.round((y / 9) * 100) / 100, Math.round((w / 16) * 100) / 100, Math.round((h / 9) * 100) / 100];

/** The instruments of the home screen as boxes in percent of the screen (the registry's 1600 x 900 canvas, divided). */
export const INSTRUMENT_RECTS: Record<HudWidgetId, Rect> = {
  system: pct(40, 70, 300, 220),
  voice: pct(40, 310, 300, 150),
  network: pct(40, 480, 300, 110),
  feed: pct(40, 650, 430, 210),
  radar: pct(1310, 60, 250, 270),
  tickets: pct(1300, 320, 270, 160),
  budget: pct(1300, 480, 270, 110),
  approval: pct(1180, 650, 380, 210),
  usage: pct(700, 215, 200, 30),
};

/** What is already on the screen that nothing of the assistant's may cover (boxes in percent). */
export interface Taken {
  panels: Rect[];
  instruments: Rect[];
}

export interface Zones {
  /** The main thing. */
  focus: Rect;
  /** The same, when the thing is big (a page, a chart, a long table). */
  focusBig: Rect;
  /** The side places, in the order they fill. */
  beside: Rect[];
  /** How many chips the strip holds. */
  chipMax: number;
  /** A phone: everything stacks in one column, the boxes do not apply. */
  stack: boolean;
}

/** More than this much of the smaller box covered counts as sitting on top of it. */
const CONFLICT = 0.25;
const MIN_FOCUS_W = 40;

// every zone starts below y 15: the strip of chips runs along the top, from 10.5 down to about 14.5
const DESKTOP = {
  focus: [26, 16, 48, 52] as Rect,
  big: [14, 15, 72, 60] as Rect,
  slots: [[75, 16, 22, 28], [3, 16, 22, 28], [75, 46, 22, 28]] as Rect[],
};
const TABLET = {
  focus: [4, 16, 64, 54] as Rect,
  big: [4, 15, 92, 60] as Rect,
  slots: [[70, 16, 26, 28], [70, 46, 26, 28]] as Rect[],
};
const PHONE = { focus: [2, 10, 96, 40] as Rect, big: [2, 10, 96, 66] as Rect };

const clampChips = (n: number): number => Math.min(12, Math.max(1, Math.round(n)));

/** The zones of a screen, with the places the owner's panels and the instruments hold left out. An unknown screen is a wide desktop. */
export function zonesFor(screen: ScreenInfo | null, taken: Taken = { panels: [], instruments: [] }, maxChips?: number): Zones {
  const all = [...taken.panels, ...taken.instruments];
  const free = (r: Rect) => !all.some((t) => overlap(r, t) > CONFLICT);
  const kind = screen?.kind ?? "desktop";
  const chips = (byKind: number) => (maxChips === undefined ? byKind : clampChips(maxChips));

  if (kind === "phone") return { focus: PHONE.focus, focusBig: PHONE.big, beside: [], chipMax: chips(5), stack: true };
  if (kind === "tablet") return { focus: TABLET.focus, focusBig: TABLET.big, beside: TABLET.slots.filter(free), chipMax: chips(5), stack: false };

  const beside = DESKTOP.slots.filter(free);
  const [fx, fy, fw, fh] = DESKTOP.focus;
  const band = all.filter((t) => t[1] < fy + fh && t[1] + t[3] > fy);
  const leftEdge = Math.max(-Infinity, ...band.filter((t) => t[0] + t[2] / 2 < 50).map((t) => t[0] + t[2]));
  const rightEdge = Math.min(Infinity, ...band.filter((t) => t[0] + t[2] / 2 >= 50).map((t) => t[0]));
  const leftOpen = free(DESKTOP.slots[1]!);
  const rightOpen = free(DESKTOP.slots[0]!) || free(DESKTOP.slots[2]!);
  let lo = Math.max(leftOpen ? fx : DESKTOP.big[0], leftEdge + 1);
  let hi = Math.min(rightOpen ? fx + fw : DESKTOP.big[0] + DESKTOP.big[2], rightEdge - 1);
  if (hi - lo < MIN_FOCUS_W) {
    lo = fx + 4;
    hi = fx + fw - 4;
  }
  const focus: Rect = [Math.round(lo * 100) / 100, fy, Math.round((hi - lo) * 100) / 100, fh];
  const bigLo = Math.max(DESKTOP.big[0], leftEdge + 1);
  const bigHi = Math.min(DESKTOP.big[0] + DESKTOP.big[2], rightEdge - 1);
  const focusBig: Rect = bigHi - bigLo >= MIN_FOCUS_W ? [Math.round(bigLo * 100) / 100, DESKTOP.big[1], Math.round((bigHi - bigLo) * 100) / 100, DESKTOP.big[3]] : focus;
  return { focus, focusBig, beside, chipMax: chips(7), stack: false };
}

const BIG_TYPES = new Set(["sandbox", "pdf", "video", "gallery", "chart"]);
const BIG_TABLE_ROWS = 6;
const BIG_JARVIS_PX = 768;

/** Whether an object needs the whole middle of the screen (and the orb to step aside). */
export function isBig(type: string, props: Record<string, unknown>): boolean {
  if (BIG_TYPES.has(type)) return true;
  if (type === "table") return Array.isArray(props.rows) && props.rows.length > BIG_TABLE_ROWS;
  if (isJarvisType(type) && jarvisObjectProblem(type, props) === null) return jarvisNaturalSize(jarvisTreeOf(type, props)).w > BIG_JARVIS_PX;
  return false;
}

const CHIP_CHARS = 24;
const cut = (s: string) => s.replace(/\s+/g, " ").trim().slice(0, CHIP_CHARS);
const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v : typeof v === "number" && Number.isFinite(v) ? String(v) : undefined);

/** What a chip shows for an object: a short label and, for numbers, the value. */
export function chipOf(o: StageObject): { label: string; value?: string } {
  const p = o.props;
  const label = cut(o.label ?? text(p.label) ?? text(p.title) ?? o.id);
  if (o.type === "stat") {
    const v = text(p.value);
    const unit = text(p.unit);
    return v === undefined ? { label } : { label, value: unit ? `${v} ${unit}` : v };
  }
  if (o.type === "gauge" || o.type === "progress") {
    const v = text(p.value);
    return v === undefined ? { label } : { label, value: `${v}%` };
  }
  return { label };
}

const LETTERS_PER_SECOND = 15;
const READ_BASE_SECONDS = 1.5;

function letters(v: unknown, depth = 0): number {
  if (typeof v === "string") return v.length;
  if (depth > 4) return 0;
  if (Array.isArray(v)) return v.reduce((n: number, x) => n + letters(x, depth + 1), 0);
  if (v && typeof v === "object") return Object.values(v as Record<string, unknown>).reduce((n: number, x) => n + letters(x, depth + 1), 0);
  return 0;
}

/** How long the text of an object needs to be read: letters / 15 + 1.5 seconds. */
export function readSeconds(o: StageObject): number {
  return letters(o.props) / LETTERS_PER_SECOND + READ_BASE_SECONDS;
}

const DENSITY_RANK: Record<HudDensity, number> = { calm: 0, standard: 1, full: 2 };
const LIVE: readonly HudWidgetId[] = ["system", "voice", "network", "feed", "radar", "tickets"];

/**
 * Which instruments the home screen draws right now: the same rule the screen uses (the owner's switches win, the live instruments
 * need to be switched on or brought up, the budget ring and usage line follow the density, a waiting approval is always there).
 * The layout keeps clear of these.
 */
export function hudInstrumentsOn(density: HudDensity, widgets: Partial<Record<HudWidgetId, boolean>>, brought: readonly HudWidgetId[], approvalPending: boolean): HudWidgetId[] {
  return HUD_WIDGET_IDS.filter((id) => {
    if (id === "approval" && approvalPending) return true;
    const choice = widgets[id];
    if (choice === false) return false;
    if (id === "approval") return choice === true;
    if (LIVE.includes(id)) return choice === true || brought.includes(id);
    if (choice === true) return true;
    return DENSITY_RANK[density] >= DENSITY_RANK[id === "usage" ? "calm" : "standard"];
  });
}
