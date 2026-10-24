import { REGION_NAMES, REGIONS, clampToSafe, isJarvisType, jarvisNaturalSize, jarvisObjectProblem, jarvisTreeOf, overlap, rectOf, type Placement, type Rect, type RegionName, type ScreenInfo, type StageObject } from "@friend/protocol";

/** How many pictures a phone screen shows comfortably at once (they stack in one column). */
export const PHONE_COMFORT = 2;

/** What the model is told about the screen it is drawing on, and what that means for the layout. */
export function describeDevice(screen: ScreenInfo | null): string {
  if (!screen) return "screen: size unknown (assume a wide desktop)";
  const base = `screen: ${screen.kind}, ${screen.orientation}, ${screen.width}x${screen.height} px${screen.touch ? ", touch (no keyboard or mouse)" : ""}`;
  if (screen.kind === "phone") {
    return `${base}. Objects stack in one column here and the regions do not apply: placement is ignored, so say things short, show at most ${PHONE_COMFORT} pictures at once, prefer a stat, gauge, list or card over a wide chart or table, and avoid sandbox pages that need a wide area`;
  }
  if (screen.kind === "tablet") {
    return `${base}. Medium screen: up to 3 or 4 pictures, "left" and "right" work, keep text large and short`;
  }
  return `${base}. Wide screen: all regions work, up to 6 pictures`;
}

/** More than this much of the smaller box covered counts as sitting on top of it. */
const CONFLICT = 0.25;

/** Which spot to try next when the one asked for is taken; wide things first to the sides, then the strips. */
const FALLBACKS: RegionName[] = ["right", "left", "center", "bottom", "top"];

const label = (p: Placement): string => (typeof p === "string" ? p : "a custom box");

/** Auto objects flow in a grid that fills the middle of the screen, so they take that part. */
const boxOf = (o: StageObject): Rect | null => (o.placement === "auto" ? REGIONS.center : rectOf(o.placement));

function whoIsIn(box: Rect, others: StageObject[], except: string): StageObject | undefined {
  return others.find((o) => {
    if (o.id === except) return false;
    const b = boxOf(o);
    return !!b && overlap(box, b) > CONFLICT;
  });
}

export type PanelName = "chat" | "tasks";

/** Where the owner's side panels sit by default (they can drag them, but this is what the AI plans around). */
export const PANEL_RECTS: Record<PanelName, Rect> = { chat: [70, 12, 28, 62], tasks: [2, 12, 26, 40] };
const PANEL_TEXT: Record<PanelName, string> = { chat: "the chat panel (right edge)", tasks: "the schedule panel (upper left)" };

/** The panels the owner has open, as objects that nothing may be placed on. */
function panelObjects(panels: PanelName[]): StageObject[] {
  return panels.map((p) => {
    const [x, y, w, h] = PANEL_RECTS[p];
    return { id: PANEL_TEXT[p], type: "card", props: {}, placement: { x: x / 100, y: y / 100, w: w / 100, h: h / 100 } };
  });
}

/** The bar a Jarvis card is moved by, in pixels, and a little air round what is drawn. */
const JARVIS_BAR = 28;
const JARVIS_AIR = 1.08;

/** A Jarvis drawing gets the box its content needs (the assistant often gives it a square that is far too big or small). Auto stays auto. */
function sizeJarvis(object: StageObject, screen: ScreenInfo | null): { object: StageObject; note?: string } {
  if (!isJarvisType(object.type) || object.placement === "auto" || jarvisObjectProblem(object.type, object.props) !== null) return { object };
  const sw = screen?.width && screen.width > 200 ? screen.width : 1920;
  const sh = screen?.height && screen.height > 200 ? screen.height : 1080;
  const nat = jarvisNaturalSize(jarvisTreeOf(object.type, object.props));
  const w = Math.min(0.9, (nat.w * JARVIS_AIR) / sw);
  const h = Math.min(0.75, (nat.h * JARVIS_AIR + JARVIS_BAR) / sh);
  const r = (n: number) => Math.round(n * 1000) / 1000;
  let x: number;
  let y: number;
  if (typeof object.placement === "object") {
    x = object.placement.x;
    y = object.placement.y;
  } else {
    const [rx, ry, rw, rh] = REGIONS[object.placement];
    x = (rx + (rw - w * 100) / 2) / 100;
    y = (ry + (rh - h * 100) / 2) / 100;
  }
  const placement = { x: r(Math.max(0, x)), y: r(Math.max(0, y)), w: r(w), h: r(h) };
  const same = typeof object.placement === "object" && Math.abs(object.placement.w - placement.w) < 0.02 && Math.abs(object.placement.h - placement.h) < 0.02;
  return same ? { object } : { object: { ...object, placement }, note: `Size changed: this card needs about ${Math.round(nat.w)}x${Math.round(nat.h)} px, so the box is ${Math.round(placement.w * sw)}x${Math.round(placement.h * sh)} px (a Jarvis card is an instrument, not a banner)` };
}

export interface Placed {
  object: StageObject;
  /** What was changed and why, in words the model can learn from; absent when the object went where it asked. */
  note?: string;
}

/**
 * Keeps one object from landing on top of another or on the always-visible parts of the screen. A box that sticks out is
 * moved inside the safe area; a spot that is taken is swapped for a free one (or "auto"). Nothing is ever refused.
 */
export function placeObject(object: StageObject, shown: StageObject[], panels: PanelName[] = [], screen: ScreenInfo | null = null): Placed {
  // a phone stacks everything in one column: regions and boxes mean nothing there
  if (screen?.kind === "phone") {
    if (object.placement === "auto") return { object };
    return { object: { ...object, placement: "auto" }, note: "Placement changed: this is a phone, where objects stack in one column, so it was set to auto." };
  }
  const sized = sizeJarvis(object, screen);
  const onScreen = [...shown, ...panelObjects(panels)];
  let placement = sized.object.placement;
  const notes: string[] = sized.note ? [sized.note.replace(/\.$/, "")] : [];

  if (typeof placement === "object") {
    const want: Rect = [placement.x * 100, placement.y * 100, placement.w * 100, placement.h * 100];
    const fit = clampToSafe(want);
    if (fit.some((v, i) => Math.abs(v - want[i]!) > 0.01)) {
      placement = { x: fit[0] / 100, y: fit[1] / 100, w: fit[2] / 100, h: fit[3] / 100 };
      notes.push("moved inside the safe area (the top strip, the captions at the bottom, the status line and the clock stay free)");
    }
  }

  const box = placement === "auto" ? null : rectOf(placement);
  if (box) {
    const blocker = whoIsIn(box, onScreen, object.id);
    if (blocker) {
      const free = FALLBACKS.find((r) => r !== placement && !whoIsIn(REGIONS[r], onScreen, object.id));
      const was = label(object.placement);
      placement = free ?? "auto";
      notes.push(`put at ${placement} instead of ${was} because ${blocker.type === "card" && blocker.id.startsWith("the ") ? blocker.id : `"${blocker.id}" (${blocker.type})`} is there`);
    }
  }

  if (placement === object.placement) return { object };
  return { object: { ...object, placement }, note: `Placement changed: ${notes.join("; ")}.` };
}

/** Names the named regions that something occupies, and the ones left free. */
export function regionUse(objects: StageObject[]): { used: Map<RegionName, StageObject[]>; free: RegionName[] } {
  const used = new Map<RegionName, StageObject[]>();
  for (const name of REGION_NAMES) {
    const hits = objects.filter((o) => {
      const b = boxOf(o);
      return !!b && overlap(REGIONS[name], b) > CONFLICT;
    });
    if (hits.length) used.set(name, hits);
  }
  return { used, free: REGION_NAMES.filter((n) => !used.has(n)) };
}

/**
 * What the model is told about the screen with every request: what is on it and where, how long each thing will stay,
 * and which spots are free. The fixed parts of the screen are in the system prompt's layout guide.
 */
export function describeScreen(
  scene: string,
  presence: string,
  entries: { object: StageObject; expiresAt: number | null }[],
  now: number,
  panels: PanelName[] = [],
  screen: ScreenInfo | null = null,
  view?: string,
  accent?: string,
): string {
  const open = panels.length ? `; the owner has open: ${panels.map((p) => PANEL_TEXT[p]).join(", ")}, so keep clear of them` : "";
  const known = [screen ? describeDevice(screen) : "", view ? `view=${view}` : "", accent ? `accent=${accent}` : ""].filter(Boolean);
  const device = known.length ? `${known.join("; ")}; ` : "";
  const phone = screen?.kind === "phone";
  const taken = panelObjects(panels);
  if (entries.length === 0) {
    const { free } = regionUse(taken);
    return `${device}scene=${scene}; presence=${presence}; the stage is empty${open}${phone ? "" : `; free regions: ${free.join(", ") || "none"}`}`;
  }
  const items = entries.map(({ object: o, expiresAt }) => {
    const where = typeof o.placement === "string" ? o.placement : "custom box";
    const life = o.pinned ? "pinned widget" : expiresAt === null ? "stays" : `leaves in ${Math.max(0, Math.round((expiresAt - now) / 1000))}s`;
    return `${o.id} (${o.type}, ${o.layer === "overlay" ? "overlay on top" : phone ? "stacked" : where}, ${life})`;
  });
  const { free } = regionUse([...entries.map((e) => e.object).filter((o) => o.layer !== "overlay"), ...taken]);
  return `${device}scene=${scene}; presence=${presence}; on screen: ${items.join("; ")}${open}${phone ? "" : `; free regions: ${free.join(", ") || "none, replace something first"}`}`;
}

/** The design guide for the system prompt: the fixed parts of the screen, where things go, and what lives how long. */
export const LAYOUT_GUIDE = `Screen layout (follow this when you decide where things go)
- Always on screen, never yours to cover or move: the voice presence (middle of the screen; a small round shape in the bottom-left corner during "focus" and "multi" scenes), the live captions at the bottom, a status line in the bottom-left, a small clock in the bottom-right, and the owner's notices along the top edge. Use the middle of the screen for what the owner asked to see.
- Regions for placement: "center" (the main thing), "left" and "right" (two things side by side), "top" and "bottom" (wide banners: a timeline, a short note). They overlap in places: center overlaps left and right, top and bottom overlap center. Use "auto" for three or more objects: they flow in a tidy grid. Avoid custom boxes; if you must, stay between 2% and 98% across and 10% to 78% down.
- Use the whole screen. On a desktop the screen is large: give each thing its own object in its own place (center, left, right, top, bottom, or a box {x,y,w,h} for the corners), so the owner sees many things at once, like a control room: a gauge here, a chart there, a status card in a corner. Do not pack a whole answer into one card or one group. A Jarvis card is an instrument, not a wide banner: give it the box its content needs (the Jarvis component list in stage.guide gives each component's size in pixels), and put its neighbours beside it, with dark space between. One thing, "center"; two, "left" and "right"; three or more, "auto" with scene "multi" or place each yourself. Give the biggest or most important object the most room. A sandbox page or a big chart takes the whole stage: use scene "focus" and "center".
- Check "on screen" and "free regions" in each request before you place anything. Update an object (same id) only when it is the same thing refreshed (a gauge getting a new value). A different topic is a new object: never reuse an old card for it. If the new answer replaces the old one, hide the old objects or use stage.clear first; you may clear the screen whenever you need the room. If you place something on top of something else, the system moves it and tells you; use that to choose better next time.
- Lifetimes: things the owner asked to see stay until they dismiss them or you replace them. Passing information (a reminder, a progress note, a one-off confirmation) gets a ttl of 15 to 60 seconds. Never leave stale objects: remove what no longer matters when the topic changes.
- Know the screen you are drawing on: each request starts with "screen:" (phone, tablet or desktop, portrait or landscape, its size) and "view=". Lay things out for it: on a phone everything stacks in one column, so show at most two short pictures at a time and prefer a stat, gauge, list or card; on a tablet use up to four; on a wide desktop use the regions. If the screen changes (the owner turns the phone, or opens Friend on another device), the next request tells you; adapt without being asked.
- Temporary and pinned. What you show for a task is temporary: when the task is done and the owner has what they need, take it off the screen (stage.hide for one, stage.clear for all) so the screen goes back to how the owner keeps it. Pinned widgets are the owner's: they stay across refreshes, logins and restarts, in the place the owner dragged them to, and stage.clear leaves them alone. Pin something with stage.pin only when the owner asks for it to stay, or when you offer and they agree (for example a clock, a to-do list, a status gauge). Never hide, move or unpin a pinned widget unless the owner asks. To change what a pinned widget shows, stage.update it by its id.
- Pick the object by the data: one number gauge or stat, a few numbers side by side stat, a trend chart, items with details table, a to-do or schedule list or timeline, relationships graph, a short note card, anything else a sandbox page. Keep text short; the pictures carry the answer and your voice adds one or two sentences.
- The owner can open a chat panel (right edge) and a schedule panel (upper left); the request's screen description lists them when open. Keep your pictures out of their way and do not repeat what they already show. The owner arranges the corner widgets and panels themselves; never try to move them. Change what the screen shows with view.set only when the owner asks for a cleaner or fuller screen.
- The look of the voice presence (style, colour, brightness, size) belongs to the owner. If stage.presence or stage.mood say the look is fixed, accept it. Use look.set only when the owner asks you to change it.
- The theme is a HUD, like the screens in science-fiction films: a near-black blue background, translucent glass panels with thin glowing edges, one bright accent colour, small upper-case letter-spaced labels, and monospace for numbers and code. Nothing is white, nothing is solid or rounded and cheerful. The colours are: accent (the current one is in each request as accent=#rrggbb; default cyan #3fd8ff), ink #d4ecf7 for text, muted #7fa3b6 for labels, ok #5ef0b0 for good, warn #ffb454 for caution, bad #ff6b7a for errors, background #050b10, glass rgba(6,20,28,0.62). Use warn and bad only for real warnings. Do not invent other colours, and never put dark text on a dark background. In a sandbox page do not write colours at all: use var(--accent), var(--ink), var(--muted), var(--ok), var(--warn), var(--bad), var(--glass), var(--edge), var(--ui) and var(--mono); they follow the owner's theme and accent exactly. Draw with thin lines (1px), a soft glow (box-shadow or drop-shadow of var(--accent)) and transparent backgrounds.
- What is already on the screen decides how you show something new. A short explanation or quick answer while widgets are showing goes ON TOP: stage.show with layer "overlay" (it floats over a dimmed screen, moves nothing, and leaves by itself after 30 seconds or your ttl). Something IMPORTANT or urgent (an error, a warning, something the owner must act on): stage.clear first (pinned widgets stay), then show it alone, scene "focus", style "alert" for a warning. A new topic: clear, then show. More of the same topic: update the objects you have. Call stage.guide (topics widgets, layout, overlay, theme, files, recipes) for the full manual before building a screen you have not built before.
- One object for each thing. Put things in one group or one tabs object only when the owner asks for a single combined panel; otherwise each stat, gauge, list, chart or Jarvis card gets its own place. Use a gallery for several pictures or clips; use markdown for a formatted explanation; use checklist, progress, kv and countdown instead of a card of text when the data has that shape.
- Showing the owner's files: use file.present with the full path (the owner approves each file with their PIN). It shows images and GIFs, video and sound, PDFs, Markdown, text, CSV (as a table) and code. After you arrange the screen you may use screen.look (PIN) to see the result yourself, but only when it helps: check that nothing overlaps and text is readable, then fix what is wrong. Never take a picture of the screen unless it is needed.
- Schedules and to-dos: get them with the task tools (never guess), show them as a timeline (times) or list (to-dos) on the right, and keep them until the owner dismisses them.`;
