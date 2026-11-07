import { INSTRUMENT_RECTS, ObjectRole, chipOf, isBig, rectOf, zonesFor, type HudWidgetId, type Placement, type Rect, type SceneMode, type ScreenInfo, type StageObject } from "@friend/protocol";
import { PANEL_RECTS, type PanelName } from "./layout";

/** The most objects the screen holds at once (shown and put away). */
export const MAX_SCREEN_OBJECTS = 12;

/** What the assistant says about one thing: what it is and what it is for, never where it goes. */
export interface ComposeItem {
  id: string;
  type: string;
  props: Record<string, unknown>;
  role: ObjectRole;
  /** The text of its chip when it is put away. */
  label?: string;
  /** For a note: how long it stays, in seconds (kept between 15 and 60). */
  ttl?: number;
}

/** Everything the layout depends on. */
export interface ComposeState {
  screen: ScreenInfo | null;
  panels: PanelName[];
  /** The live instruments that are on the home screen right now. */
  instruments: HudWidgetId[];
  /** What is on the screen now, oldest first (shown, put away and pinned). */
  current: StageObject[];
  /** Objects the owner moved by hand: they keep their place. */
  ownerPlaced: ReadonlySet<string>;
  maxChips?: number;
}

export interface ComposeResult {
  /** Objects to show (new, updated, or moved), with their places. */
  show: StageObject[];
  /** Objects to remove. */
  hide: string[];
  /** Objects that go away as chips. */
  dock: string[];
  /** Objects that come back from chips as cards. */
  undock: string[];
  scene: SceneMode;
  /** What was changed and why, in words the assistant can learn from. */
  notes: string[];
}

const NOTE_MIN_S = 15;
const NOTE_MAX_S = 60;
const NOTE_DEFAULT_S = 30;

const round3 = (n: number) => Math.round(n * 1000) / 1000;
const asPlacement = (r: Rect): Placement => ({ x: round3(r[0] / 100), y: round3(r[1] / 100), w: round3(r[2] / 100), h: round3(r[3] / 100) });
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));
const kindOf = (s: ScreenInfo | null) => s?.kind ?? "desktop";

/**
 * Turns what the assistant means (this is the focus, these go beside it, this is a small thing to keep in view...) into places for
 * this screen. Pure: the same input gives the same screen. Pinned widgets and objects the owner moved are never touched; whatever does
 * not fit is put away as a chip, never lost; the call throws a plain sentence when it cannot be done.
 */
export function composeScreen(items: ComposeItem[], mode: "replace" | "add", st: ComposeState): ComposeResult {
  if (items.length === 0) throw new Error("There is nothing to show: give at least one item.");
  const seen = new Set<string>();
  for (const it of items) {
    if (!ObjectRole.safeParse(it.role).success) throw new Error(`Unknown role "${String(it.role)}". Use focus, beside, glance, note or alert.`);
    if (seen.has(it.id)) throw new Error(`The id "${it.id}" is used twice in one call.`);
    seen.add(it.id);
  }
  const alert = items.some((i) => i.role === "alert");
  const replace = mode === "replace" || alert;
  const notes: string[] = [];
  const hide: string[] = [];
  const dock: string[] = [];
  const undock: string[] = [];
  const byId = new Map(st.current.map((o) => [o.id, o]));
  const roleOf = (o: StageObject): ObjectRole => o.role ?? "beside";

  // pinned widgets and owner-placed objects: never moved, and what they hold is not available to anything else
  const out: StageObject[] = [];
  const held: Rect[] = [];
  const mine: ComposeItem[] = [];
  for (const it of items) {
    const old = byId.get(it.id);
    if (old?.pinned || (old && st.ownerPlaced.has(it.id))) {
      out.push({ ...old, type: it.type, props: it.props, ...(it.role !== "note" ? { role: it.role } : {}) });
      notes.push(`"${it.id}" ${old.pinned ? "is a pinned widget" : "was placed by the owner"}, so it stayed where it is.`);
    } else mine.push(it);
  }
  for (const o of st.current) {
    const r = o.pinned || st.ownerPlaced.has(o.id) ? rectOf(o.placement) : null;
    if (r && !o.docked) held.push(r);
  }

  // what was on the screen and is not mentioned: kept (add), or put away without loss (replace)
  const kept: StageObject[] = [];
  const chips: { id: string; isNew: boolean }[] = [];
  for (const o of st.current) {
    if (o.pinned || st.ownerPlaced.has(o.id) || seen.has(o.id)) continue;
    if (o.docked) {
      chips.push({ id: o.id, isNew: false });
      kept.push(o);
    } else if (replace) {
      if (o.layer === "overlay") hide.push(o.id);
      else {
        dock.push(o.id);
        chips.push({ id: o.id, isNew: false });
      }
    } else kept.push(o);
  }

  const listedFocus = mine.filter((i) => i.role === "focus" || i.role === "alert");
  const focusItem = listedFocus[0];
  const baseItems = mine.filter((i) => i.role === "beside" || i.role === "focus" || i.role === "alert");
  // a second focus becomes a side card; an existing focus is put away when a new one comes
  const sideItems = baseItems.filter((i) => i !== focusItem);
  const keptBase = kept.filter((o) => !o.docked && o.layer !== "overlay");
  let keptFocus = keptBase.find((o) => roleOf(o) === "focus");
  if (keptFocus && focusItem) {
    dock.push(keptFocus.id);
    chips.push({ id: keptFocus.id, isNew: false });
    keptFocus = undefined;
  }
  const keptSides = keptBase.filter((o) => o !== keptFocus);

  const zones = zonesFor(
    st.screen,
    { panels: [...st.panels.map((p) => PANEL_RECTS[p]), ...held], instruments: st.instruments.filter((i) => i !== "usage").map((i) => INSTRUMENT_RECTS[i]) },
    st.maxChips,
  );
  const cap = zones.stack ? 1 : zones.beside.length;
  const place = (r: Rect): Placement => (zones.stack ? "auto" : asPlacement(r));

  // the side places: existing cards first (they are older), then the new ones; what does not fit goes away as a chip
  type Side = { existing?: StageObject; item?: ComposeItem };
  const sides: Side[] = [...keptSides.map((existing) => ({ existing })), ...sideItems.map((item) => ({ item }))];
  while (sides.length > cap) {
    // the oldest card on screen goes first; among the new ones, the ones named last (they matter least)
    const oldest = sides.findIndex((s) => s.existing);
    const gone = sides.splice(oldest === -1 ? sides.length - 1 : oldest, 1)[0]!;
    const id = gone.existing?.id ?? gone.item!.id;
    const why = zones.stack ? "a phone shows one card at a time under the main thing" : `a ${kindOf(st.screen)} here has ${cap} place${cap === 1 ? "" : "s"} beside the main thing`;
    notes.push(`"${id}" was put away as a chip: ${why}.`);
    if (gone.existing) {
      dock.push(id);
      chips.push({ id, isNew: false });
    } else {
      const it = gone.item!;
      out.push({ id: it.id, type: it.type, props: it.props, placement: "auto", role: "beside", docked: true, ...(it.label ? { label: it.label } : {}) });
      chips.push({ id, isNew: true });
    }
  }

  let anyBig = false;
  const toObject = (it: ComposeItem, placement: Placement): StageObject => ({
    id: it.id,
    type: it.type,
    props: it.props,
    placement,
    role: it.role,
    ...(it.role === "alert" ? { style: "alert" as const } : {}),
    ...(it.label ? { label: it.label } : {}),
  });

  if (focusItem) {
    const big = focusItem.role === "alert" ? true : isBig(focusItem.type, focusItem.props);
    anyBig = big;
    out.push(toObject(focusItem, place(big ? zones.focusBig : zones.focus)));
  } else if (keptFocus) {
    const big = isBig(keptFocus.type, keptFocus.props);
    anyBig = big;
    const placement = place(big ? zones.focusBig : zones.focus);
    if (!same(placement, keptFocus.placement)) out.push({ ...keptFocus, placement });
  }
  sides.forEach((s, i) => {
    const placement = place(zones.beside[i] ?? zones.focus);
    if (s.item) out.push(toObject(s.item, placement));
    else if (!same(placement, s.existing!.placement)) out.push({ ...s.existing!, placement });
  });

  for (const it of mine) {
    if (it.role === "glance") {
      out.push({ id: it.id, type: it.type, props: it.props, placement: "auto", role: "glance", docked: true, ...(it.label ? { label: it.label } : {}) });
      chips.push({ id: it.id, isNew: true });
    } else if (it.role === "note") {
      out.push({ id: it.id, type: it.type, props: it.props, placement: "center", role: "note", layer: "overlay", ttl: clamp(it.ttl ?? NOTE_DEFAULT_S, NOTE_MIN_S, NOTE_MAX_S), ...(it.label ? { label: it.label } : {}) });
    }
  }
  for (const it of items) if (byId.get(it.id)?.docked && out.find((o) => o.id === it.id && !o.docked)) undock.push(it.id);

  // chips: no more than the strip holds, oldest first out
  const dropChip = (id: string, why: string) => {
    notes.push(`The chip "${id}" was dropped: ${why}.`);
    const i = chips.findIndex((c) => c.id === id);
    const [c] = chips.splice(i, 1);
    if (c!.isNew) out.splice(out.findIndex((o) => o.id === id), 1);
    else {
      const d = dock.indexOf(id);
      if (d !== -1) dock.splice(d, 1);
      hide.push(id);
    }
  };
  while (chips.length > zones.chipMax) dropChip(chips[0]!.id, `the strip holds ${zones.chipMax}`);

  // the screen holds twelve things in all
  const total = () => st.current.filter((o) => !hide.includes(o.id) && !seen.has(o.id)).length + out.filter((o) => !byId.has(o.id) || seen.has(o.id)).length;
  while (total() > MAX_SCREEN_OBJECTS) {
    const old = chips.find((c) => !c.isNew);
    if (!old) throw new Error(`Too many things for the screen (the limit is ${MAX_SCREEN_OBJECTS}). Hide something first.`);
    dropChip(old.id, `the screen holds ${MAX_SCREEN_OBJECTS} things`);
  }

  const baseShown = out.filter((o) => !o.docked && o.layer !== "overlay").length + keptBase.filter((o) => !out.some((x) => x.id === o.id) && !dock.includes(o.id)).length;
  const scene: SceneMode = alert || anyBig ? "focus" : baseShown >= 2 ? "multi" : "conversation";
  return { show: out, hide, dock, undock, scene, notes };
}

/** Brings a chip back as a card (the oldest card beside is put away when there is no room). */
export function restoreScreen(id: string, st: ComposeState): ComposeResult {
  const o = st.current.find((x) => x.id === id);
  if (!o) throw new Error(`There is nothing on screen called "${id}".`);
  if (!o.docked) return { show: [], hide: [], dock: [], undock: [], scene: "conversation", notes: [] };
  const role: ObjectRole = o.role === "focus" ? "focus" : "beside";
  return composeScreen([{ id, type: o.type, props: o.props, role, ...(o.label ? { label: o.label } : {}) }], "add", st);
}
