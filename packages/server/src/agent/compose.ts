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
  /** The screen changed (nothing new was asked for): no chip may be dropped to fit a smaller strip. */
  keepChips?: boolean;
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
  /** The ones among those put away (or shown as chips) only because the screen had no room: they come back when it has. */
  squeezed: string[];
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
  const squeezed: string[] = [];
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
    } else if (o.role === undefined) {
      // drawn the old way (stage.show with a place): it stays where it is and the new layout keeps clear of it
      const r = rectOf(o.placement);
      if (r) held.push(r);
    } else kept.push(o);
  }

  const listedFocus = mine.filter((i) => i.role === "focus" || i.role === "alert");
  let focusItem = listedFocus[0];
  // an alert stays until the owner has dealt with it or a new topic replaces it: more shown meanwhile goes beside it
  const keptAlert = kept.find((o) => !o.docked && o.layer !== "overlay" && o.role === "alert");
  if (keptAlert && focusItem && focusItem.role !== "alert") {
    notes.push(`"${focusItem.id}" was put beside, not as the focus: the alert "${keptAlert.id}" is still shown.`);
    focusItem = undefined;
  }
  const baseItems = mine.filter((i) => i.role === "beside" || i.role === "focus" || i.role === "alert");
  // a second focus becomes a side card; an existing focus is put away when a new one comes
  const sideItems = baseItems.filter((i) => i !== focusItem);
  const keptBase = kept.filter((o) => !o.docked && o.layer !== "overlay");
  let keptFocus = keptBase.find((o) => roleOf(o) === "focus" || roleOf(o) === "alert");
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
    notes.push(`"${id}" was put away as a chip: ${why}. The owner can tap its chip to bring it back; to see it now, make it the focus. Do not place it by hand with stage.show: that covers the screen's own instruments.`);
    squeezed.push(id);
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

  // a big focus takes the middle only when there is nothing beside it; with cards beside it keeps its own place so it never covers them
  const bigRoom = sides.length === 0;
  if (focusItem) {
    const big = focusItem.role === "alert" ? true : isBig(focusItem.type, focusItem.props);
    anyBig = big;
    out.push(toObject(focusItem, place(big && bigRoom ? zones.focusBig : zones.focus)));
  } else if (keptFocus) {
    const big = keptFocus.role === "alert" ? true : isBig(keptFocus.type, keptFocus.props);
    anyBig = big;
    const placement = place(big && bigRoom ? zones.focusBig : zones.focus);
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
  while (!st.keepChips && chips.length > zones.chipMax) dropChip(chips[0]!.id, `the strip holds ${zones.chipMax}`);

  // the screen holds twelve things in all
  const total = () => st.current.filter((o) => !hide.includes(o.id) && !seen.has(o.id)).length + out.filter((o) => !byId.has(o.id) || seen.has(o.id)).length;
  while (!st.keepChips && total() > MAX_SCREEN_OBJECTS) {
    const old = chips.find((c) => !c.isNew);
    if (!old) throw new Error(`Too many things for the screen (the limit is ${MAX_SCREEN_OBJECTS}). Hide something first.`);
    dropChip(old.id, `the screen holds ${MAX_SCREEN_OBJECTS} things`);
  }

  const baseShown = out.filter((o) => !o.docked && o.layer !== "overlay").length + keptBase.filter((o) => !out.some((x) => x.id === o.id) && !dock.includes(o.id)).length;
  const scene: SceneMode = alert || anyBig ? "focus" : baseShown >= 2 ? "multi" : "conversation";
  return { show: out, hide, dock, undock, squeezed, scene, notes };
}

/** Brings a chip back as a card (the oldest card beside is put away when there is no room). */
export function restoreScreen(id: string, st: ComposeState): ComposeResult {
  const o = st.current.find((x) => x.id === id);
  if (!o) throw new Error(`There is nothing on screen called "${id}".`);
  if (!o.docked) return { show: [], hide: [], dock: [], undock: [], squeezed: [], scene: "conversation", notes: [] };
  const role: ObjectRole = o.role === "focus" ? "focus" : "beside";
  return composeScreen([{ id, type: o.type, props: o.props, role, ...(o.label ? { label: o.label } : {}) }], "add", st);
}

const plainWords = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** What is counted as a thing on the screen: not a pinned widget (the owner's), not a passing note, not something put away. */
const counted = (o: StageObject) => !o.pinned && !o.docked && o.layer !== "overlay";

/** Design problems of the screen as it is, in short sentences the assistant can act on. Empty when the screen is fine. */
export function designFindings(objects: StageObject[], screen: ScreenInfo | null): string[] {
  const out: string[] = [];
  const kind = kindOf(screen);
  const cap = zonesFor(screen).beside.length || 1;
  const shown = objects.filter(counted);
  if (shown.length >= 2 && !shown.some((o) => o.role === "focus" || o.role === "alert")) {
    out.push(`There is no focus: ${shown.length} things are shown and none is the main thing. Make the one the owner asked for the focus (screen.compose, role focus) and put the others beside it or away.`);
  }
  if (shown.length > 1 + cap) {
    out.push(`${plainWords(shown.length, "thing is", "things are")} on the screen but a ${kind} shows ${1 + cap} well. Put the rest away (stage.hide) or use screen.compose so they become chips.`);
  }
  for (const f of shown.filter((o) => o.role === "focus" && typeof o.placement === "object")) {
    const w = (f.placement as { w: number }).w;
    if (w < 0.33 && shown.length > 1) out.push(`The focus "${f.id}" is small (${Math.round(w * 100)}% of the width) next to the others. Give the main thing more room.`);
  }
  return out;
}

/** The zones of the screen for the request's screen line: what is free, and what is put away. */
export function describeZones(st: ComposeState): string {
  const zones = zonesFor(
    st.screen,
    { panels: st.panels.map((p) => PANEL_RECTS[p]), instruments: st.instruments.filter((i) => i !== "usage").map((i) => INSTRUMENT_RECTS[i]) },
    st.maxChips,
  );
  const docked = st.current.filter((o) => o.docked);
  const chips = docked.length ? docked.map((o) => { const c = chipOf(o); return c.value ? `${c.label} ${c.value}` : c.label; }).join(", ") : "none";
  const strip = `chips (${docked.length} of ${zones.chipMax}): ${chips}`;
  const shown = st.current.filter(counted);
  const focusTaken = shown.some((o) => o.role === "focus" || o.role === "alert");
  if (zones.stack) return `zones: stacked (one card at a time under the main thing); ${strip}`;
  const used = shown.filter((o) => o.role === "beside").length;
  return `zones: focus ${focusTaken ? "taken" : "free"}, beside ${Math.max(0, zones.beside.length - used)} of ${zones.beside.length} free; ${strip}`;
}
