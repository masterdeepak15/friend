import {
  OBJECT_TYPES,
  isJarvisType,
  jarvisObjectProblem,
  StageCommand,
  TOOL_DEFS,
  type HudInstrument,
  type HudWidgetId,
  type SceneMode,
  type ScreenInfo,
  type ServerMsg,
  type StageObject,
  type StageSnapshot,
  type ToolResult,
} from "@friend/protocol";

import { GUIDE_TOPICS, screenGuide, type GuideTopic } from "./agent/guide";
import { composeScreen, restoreScreen, type ComposeItem, type ComposeResult, type ComposeState } from "./agent/compose";
import { describeScreen, placeObject, type PanelName } from "./agent/layout";
import type { LookConfig } from "./config";

const MAX_OBJECTS = 12;
/** How long an overlay stays when the AI gives no time. */
export const OVERLAY_TTL_S = 30;
/** Largest page the agent may draw in a sandbox object. */
export const MAX_SANDBOX_HTML = 100_000;

/** A sandbox page must be text and small; other object types are rendered as data and need no check. */
function sandboxError(type: string, props: Record<string, unknown>, requireHtml: boolean): string | null {
  if (type !== "sandbox") return null;
  if (!("html" in props) && !requireHtml) return null;
  const html = props.html;
  if (typeof html !== "string") return "A sandbox object needs its page as text in props.html.";
  if (html.length > MAX_SANDBOX_HTML) return `A sandbox page can be at most ${MAX_SANDBOX_HTML} characters.`;
  return null;
}

/** Where a picture, clip or document may come from: only a file the owner approved through file.present. Never a web address. */
export const MEDIA_SRC = /^\/api\/media\/[0-9a-f]{32}$/;
/** A video from the internet is played through Friend: this address is made by Friend (web video), and only a video card may use it. */
export const VIDEO_SRC = /^\/api\/video\/[0-9a-f]{32}$/;
/** A YouTube video id, for YouTube's own player. */
const YOUTUBE_ID = /^[A-Za-z0-9_-]{11}$/;
const NOT_IN_COMPOSITE = new Set(["group", "tabs", "sandbox"]);
const MAX_PARTS = 8;
const MEDIA_TYPES = new Set(["image", "video", "pdf"]);

function partsError(parts: unknown, what: string): string | null {
  if (!Array.isArray(parts) || parts.length === 0) return `${what} needs a list with at least one part.`;
  if (parts.length > MAX_PARTS) return `${what} can have at most ${MAX_PARTS} parts.`;
  for (const p of parts) {
    const part = (p && typeof p === "object" ? p : {}) as { type?: unknown; props?: unknown };
    if (typeof part.type !== "string" || !(OBJECT_TYPES as readonly string[]).includes(part.type)) return `${what}: every part needs a known type.`;
    if (NOT_IN_COMPOSITE.has(part.type)) return `${what}: a part cannot be a ${part.type}.`;
    const props = (part.props && typeof part.props === "object" ? part.props : {}) as Record<string, unknown>;
    const bad = propsError(part.type, props, true);
    if (bad) return bad;
  }
  return null;
}

/** Checks what the screen would otherwise have to cope with: sandbox pages, media sources, and parts inside group and tabs. */
export function propsError(type: string, props: Record<string, unknown>, requireAll: boolean): string | null {
  const sandbox = sandboxError(type, props, requireAll);
  if (sandbox) return sandbox;
  if (type === "video" && "embed" in props) {
    // YouTube's own player: by the video's id and nothing else (never an address)
    if (typeof props.embed !== "string" || !YOUTUBE_ID.test(props.embed)) return "A video's embed must be a YouTube video id.";
    if ("start" in props && (typeof props.start !== "number" || !Number.isFinite(props.start) || props.start < 0 || props.start > 86400)) return "A video's start must be a number of seconds.";
    return null;
  }
  if (MEDIA_TYPES.has(type) && (requireAll || "src" in props)) {
    if (typeof props.src !== "string" || !(MEDIA_SRC.test(props.src) || (type === "video" && VIDEO_SRC.test(props.src)))) return `An ${type} object needs src from file.present (a file the owner approved), not a web address.`;
  }
  if (type === "gallery" && (requireAll || "items" in props)) {
    const items = props.items;
    if (!Array.isArray(items) || items.length === 0 || items.length > 40) return "A gallery needs 1 to 40 items.";
    for (const it of items) {
      const src = (it as { src?: unknown } | null)?.src;
      if (typeof src !== "string" || !MEDIA_SRC.test(src)) return "Every gallery item needs src from file.present, not a web address.";
    }
  }
  if (isJarvisType(type)) return jarvisObjectProblem(type, props); // a Jarvis component by its own name: only its own props and plain data, never code
  if (type === "group" && (requireAll || "items" in props)) return partsError(props.items, "A group");
  if (type === "tabs" && (requireAll || "tabs" in props)) return partsError(props.tabs, "Tabs");
  return null;
}

/** `follow` holds commands the screens need as a consequence (for example the scene going back to the bare presence). */
export type ApplyResult = { ok: true; follow?: StageCommand[] } | { ok: false; error: string };

/** Where pinned widgets are kept so they survive a restart. */
export interface WidgetStore {
  load(): StageObject[];
  save(widgets: StageObject[]): void;
}

/** More widgets than this would crowd the screen. */
export const MAX_PINNED = 6;

export class StageState {
  private scene: SceneMode = "conversation";
  private objects = new Map<string, { obj: StageObject; expiresAt: number | null }>();
  private widgets = new Set<HudInstrument>();
  private presence: StageSnapshot["presence"] = { state: "idle", style: "sphere" };
  private mood: StageSnapshot["mood"] = { accent: "#3fd8ff", intensity: 0.6 };
  private store: WidgetStore | null = null;
  private screen: ScreenInfo | null = null;
  private view: (() => string) | null = null;

  /** Brings back the widgets that were pinned before, and keeps saving them from now on. */
  useStore(store: WidgetStore): void {
    this.store = store;
    for (const w of store.load()) this.objects.set(w.id, { obj: { ...w, pinned: true }, expiresAt: null });
  }

  private pinnedList(): StageObject[] {
    return [...this.objects.values()].filter((e) => e.obj.pinned).map((e) => e.obj);
  }
  private persist(): void {
    try {
      this.store?.save(this.pinnedList());
    } catch {
      /* the screen keeps working; the widgets are just not remembered this time */
    }
  }

  /** What this screen is (size, kind of device, orientation): the model lays things out for it. */
  setScreen(screen: ScreenInfo): void {
    this.screen = screen;
  }
  screenInfo(): ScreenInfo | null {
    return this.screen;
  }
  /** Where to read the owner's chosen view (minimal, companion or workspace) from. */
  trackView(read: () => string): void {
    this.view = read;
  }

  private instruments: (() => HudWidgetId[]) | null = null;
  private ownerPlaced = new Set<string>();
  /** Things put away (or shown as chips) only because there was no room: they come back when there is. */
  private squeezed = new Set<string>();

  /** Where to read which live instruments are on the home screen (the layout keeps clear of them). */
  trackInstruments(read: () => HudWidgetId[]): void {
    this.instruments = read;
  }

  private composeState(): ComposeState {
    return {
      screen: this.screen,
      panels: this.panels,
      instruments: this.instruments ? this.instruments() : [...this.widgets],
      current: [...this.objects.values()].map((e) => e.obj),
      ownerPlaced: this.ownerPlaced,
    };
  }

  /** Applies a layout result all or nothing: when one step is refused the screen stays exactly as it was. */
  private applyResult(r: ComposeResult, now: number): { ok: true; commands: StageCommand[] } | { ok: false; error: string } {
    const backup = new Map([...this.objects].map(([k, v]) => [k, { ...v }]));
    const scene = this.scene;
    const commands: StageCommand[] = [];
    const step = (c: StageCommand): string | null => {
      const a = this.apply(c, now);
      if (!a.ok) return a.error;
      commands.push(c, ...(a.follow ?? []));
      return null;
    };
    const steps: StageCommand[] = [
      ...r.hide.map((id) => ({ cmd: "hide" as const, id })),
      ...r.dock.map((id) => ({ cmd: "dock" as const, id, docked: true })),
      ...r.show.map((object) => ({ cmd: "show" as const, object })),
    ];
    for (const c of steps) {
      const error = step(c);
      if (error) {
        this.objects = backup;
        this.scene = scene;
        return { ok: false, error };
      }
    }
    if (r.scene !== this.scene) step({ cmd: "scene", mode: r.scene });
    for (const id of r.squeezed) this.squeezed.add(id);
    for (const o of r.show) if (!o.docked) this.squeezed.delete(o.id);
    for (const id of r.hide) this.squeezed.delete(id);
    return { ok: true, commands };
  }

  /** Lays the screen out from what each item is for (focus, beside, glance, note, alert). */
  compose(items: ComposeItem[], mode: "replace" | "add", now: number = Date.now()): { ok: true; commands: StageCommand[]; result: ComposeResult } | { ok: false; error: string } {
    let result: ComposeResult;
    try {
      result = composeScreen(items, mode, this.composeState());
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const done = this.applyResult(result, now);
    return done.ok ? { ...done, result } : done;
  }

  /** The owner tapped a chip: it comes back as a card. */
  restore(id: string, now: number = Date.now()): { ok: true; commands: StageCommand[]; result: ComposeResult } | { ok: false; error: string } {
    let result: ComposeResult;
    try {
      result = restoreScreen(id, this.composeState());
    } catch (e) {
      return { ok: false, error: (e as Error).message };
    }
    const done = this.applyResult(result, now);
    return done.ok ? { ...done, result } : done;
  }

  /** The screen changed (turned, resized, another device): lays the shown things out again for it. Returns what the screens must be told. */
  relayout(now: number = Date.now()): StageCommand[] {
    const items: ComposeItem[] = [...this.objects.values()]
      .map((e) => e.obj)
      .filter((o) => !o.pinned && !this.ownerPlaced.has(o.id) && o.layer !== "overlay" && o.role !== "alert" && (!o.docked || this.squeezed.has(o.id)))
      .map((o) => ({ id: o.id, type: o.type, props: o.props, role: o.role === "focus" ? ("focus" as const) : ("beside" as const), ...(o.label ? { label: o.label } : {}) }));
    if (items.length === 0) return [];
    let result: ComposeResult;
    try {
      result = composeScreen(items, "add", this.composeState());
    } catch {
      return [];
    }
    const norm = (o: unknown) => JSON.stringify(o, (_k, v: unknown) => (v && typeof v === "object" && !Array.isArray(v) ? Object.fromEntries(Object.entries(v as object).sort(([a], [b]) => a.localeCompare(b))) : v));
    result = { ...result, show: result.show.filter((o) => norm(o) !== norm(this.objects.get(o.id)?.obj)), scene: this.scene };
    const done = this.applyResult(result, now);
    return done.ok ? done.commands : [];
  }

  /** Back to the bare presence once nothing temporary is left on the screen. */
  private settle(): StageCommand[] {
    const temporary = [...this.objects.values()].some((e) => !e.obj.pinned);
    if (!temporary && (this.scene === "focus" || this.scene === "multi")) {
      this.scene = "conversation";
      return [{ cmd: "scene", mode: "conversation" }];
    }
    return [];
  }

  /**
   * Applies one command. The AI may not remove or unpin what the owner pinned: `byOwner` is set for commands that come
   * from the owner's own screen.
   */
  apply(cmd: StageCommand, now: number = Date.now(), byOwner = false): ApplyResult {
    switch (cmd.cmd) {
      case "scene":
        this.scene = cmd.mode;
        return { ok: true };
      case "show": {
        const bad = propsError(cmd.object.type, cmd.object.props, true);
        if (bad) return { ok: false, error: bad };
        const existing = this.objects.get(cmd.object.id);
        const isNew = !existing;
        if (isNew && this.objects.size >= MAX_OBJECTS) {
          return { ok: false, error: `Too many objects on screen (limit ${MAX_OBJECTS}). Hide something first.` };
        }
        // a pinned widget keeps the place the owner gave it and stays pinned when the AI shows it again with new content
        const pinned = existing?.obj.pinned === true || cmd.object.pinned === true;
        if (pinned && !existing?.obj.pinned && this.pinnedList().length >= MAX_PINNED) {
          return { ok: false, error: `There are ${MAX_PINNED} pinned widgets already. Unpin one first (only if the owner agrees).` };
        }
        const obj: StageObject = pinned
          ? { ...(({ layer: _layer, ...rest }) => rest)(cmd.object), pinned: true, ...(existing?.obj.pinned ? { placement: existing.obj.placement } : {}) } // a widget is never an overlay
          : (({ pinned: _drop, ...rest }) => rest)(cmd.object);
        const overlay = !pinned && cmd.object.layer === "overlay";
        const expiresAt = !pinned && (cmd.object.ttl || overlay) ? now + (cmd.object.ttl ?? OVERLAY_TTL_S) * 1000 : null;
        this.objects.set(obj.id, { obj, expiresAt });
        if (pinned) this.persist();
        return { ok: true };
      }
      case "update": {
        const e = this.objects.get(cmd.id);
        if (!e) return { ok: false, error: `No object with id "${cmd.id}" is on screen` };
        const bad = propsError(e.obj.type, cmd.props, false);
        if (bad) return { ok: false, error: bad };
        e.obj = { ...e.obj, props: { ...e.obj.props, ...cmd.props } };
        if (e.obj.pinned) this.persist();
        return { ok: true };
      }
      case "hide": {
        const e = this.objects.get(cmd.id);
        if (!e) return { ok: false, error: `No object with id "${cmd.id}" is on screen` };
        if (e.obj.pinned && !byOwner) return { ok: false, error: `"${cmd.id}" is a pinned widget that the owner keeps. Leave it, unless the owner asks you to remove it.` };
        this.objects.delete(cmd.id);
        this.ownerPlaced.delete(cmd.id);
        this.squeezed.delete(cmd.id);
        if (e.obj.pinned) this.persist();
        const follow = this.settle();
        return follow.length ? { ok: true, follow } : { ok: true };
      }
      case "dock": {
        const e = this.objects.get(cmd.id);
        if (!e) return { ok: false, error: `No object with id "${cmd.id}" is on screen` };
        if (e.obj.pinned && !byOwner) return { ok: false, error: `"${cmd.id}" is a pinned widget that the owner keeps. Leave it.` };
        e.obj = cmd.docked ? { ...e.obj, docked: true } : (({ docked: _d, ...rest }) => rest)(e.obj);
        return { ok: true };
      }
      case "clear": {
        // the temporary pictures go; the owner's widgets stay; the live instruments the assistant brought up go too
        for (const [id, e] of this.objects) if (!e.obj.pinned) this.objects.delete(id);
        this.ownerPlaced.clear();
        this.squeezed.clear();
        if (!cmd.keepInstruments) this.widgets.clear();
        this.scene = "conversation";
        return { ok: true };
      }
      case "widget": {
        if (cmd.reset) this.widgets.clear();
        for (const w of cmd.hide ?? []) this.widgets.delete(w);
        for (const w of cmd.show ?? []) this.widgets.add(w);
        return { ok: true };
      }
      case "pin": {
        const e = this.objects.get(cmd.id);
        if (!e) return { ok: false, error: `No object with id "${cmd.id}" is on screen` };
        if (e.obj.pinned) return { ok: true };
        if (this.pinnedList().length >= MAX_PINNED) return { ok: false, error: `There are ${MAX_PINNED} pinned widgets already. Unpin one first.` };
        e.obj = { ...e.obj, pinned: true };
        e.expiresAt = null; // a widget does not expire
        this.persist();
        return { ok: true };
      }
      case "unpin": {
        const e = this.objects.get(cmd.id);
        if (!e) return { ok: false, error: `No object with id "${cmd.id}" is on screen` };
        if (!e.obj.pinned) return { ok: true };
        const { pinned: _no, ...rest } = e.obj;
        e.obj = rest;
        this.persist();
        return { ok: true };
      }
      case "place": {
        const e = this.objects.get(cmd.id);
        if (!e) return { ok: false, error: `No object with id "${cmd.id}" is on screen` };
        e.obj = { ...e.obj, placement: cmd.placement };
        if (byOwner) this.ownerPlaced.add(cmd.id);
        if (e.obj.pinned) this.persist();
        return { ok: true };
      }
      case "presence":
        if (cmd.state) this.presence.state = cmd.state;
        if (cmd.style) this.presence.style = cmd.style;
        return { ok: true };
      case "mood":
        if (cmd.accent) this.mood.accent = cmd.accent;
        if (cmd.intensity !== undefined) this.mood.intensity = cmd.intensity;
        return { ok: true };
    }
  }

  /** Remove objects whose ttl elapsed; returns the removed ids. */
  expire(now: number = Date.now()): string[] {
    const gone: string[] = [];
    for (const [id, e] of this.objects) {
      if (e.expiresAt !== null && e.expiresAt <= now) {
        this.objects.delete(id);
        gone.push(id);
      }
    }
    return gone;
  }

  snapshot(): StageSnapshot {
    return {
      scene: this.scene,
      objects: [...this.objects.values()].map((e) => e.obj),
      presence: { ...this.presence },
      mood: { ...this.mood },
      widgets: [...this.widgets],
    };
  }

  /** What the model is told about the screen with each request: what is where, how long it stays, and what is free. */
  summary(now: number = Date.now()): string {
    return describeScreen(this.scene, this.presence.state, [...this.objects.values()].map((e) => ({ object: e.obj, expiresAt: e.expiresAt })), now, this.panels, this.screen, this.view?.(), this.mood.accent);
  }

  /** After objects left on their own (their time ran out): the commands that put the screen back to the bare presence. */
  settleNow(): StageCommand[] {
    return this.settle();
  }

  private panels: PanelName[] = [];
  private locked = false;

  /** Takes the owner's chosen style, colour and brightness as the current look; returns the commands that tell the screens. */
  setLook(look: LookConfig): StageCommand[] {
    this.presence.style = look.style;
    this.mood.accent = look.accent;
    this.mood.intensity = look.intensity;
    this.locked = !look.aiMayChange;
    return [
      { cmd: "presence", style: look.style },
      { cmd: "mood", accent: look.accent, intensity: look.intensity },
    ];
  }

  /** The owner fixed the look: the AI may not change the style, colour or brightness. */
  looksLocked(): boolean {
    return this.locked;
  }

  /** The side panels the owner has open right now; objects are kept out of their way. */
  setPanels(open: readonly string[]): void {
    this.panels = (["chat", "tasks"] as const).filter((p) => open.includes(p));
  }

  openPanels(): PanelName[] {
    return [...this.panels];
  }
}

export function runStageTool(
  name: string,
  args: unknown,
  stage: StageState,
  emit: (m: ServerMsg) => void,
): ToolResult {
  if (name === "stage.guide") {
    const topic = (args as { topic?: GuideTopic } | null | undefined)?.topic;
    if (topic !== undefined && !GUIDE_TOPICS.includes(topic)) return { ok: false, error: `Unknown topic. Use one of: ${GUIDE_TOPICS.join(", ")}.` };
    return { ok: true, output: screenGuide(topic), truncated: false };
  }
  if (name === "screen.compose") {
    const input = TOOL_DEFS.find((t) => t.name === "screen.compose")!.input.safeParse(args ?? {});
    if (!input.success) return { ok: false, error: `Invalid arguments for screen.compose: ${input.error.message}` };
    const { items, mode } = input.data as { items: ComposeItem[]; mode?: "replace" | "add" };
    const done = stage.compose(items, mode ?? "replace");
    if (!done.ok) return { ok: false, error: done.error };
    for (const command of done.commands) emit({ type: "stage", command });
    const r = done.result;
    const where = r.show.map((o) => `${o.id} (${o.docked ? "chip" : o.layer === "overlay" ? "note" : (o.role ?? "card")})`);
    const parts = [`Shown: ${where.join(", ")}.`];
    if (r.dock.length) parts.push(`Put away as chips: ${r.dock.join(", ")}.`);
    if (r.hide.length) parts.push(`Removed: ${r.hide.join(", ")}.`);
    parts.push(...r.notes);
    return { ok: true, output: `ok. ${parts.join(" ")}`, truncated: false };
  }
  const def = TOOL_DEFS.find((t) => t.name === name && t.target === "gateway");
  if (!def) return { ok: false, error: `Unknown stage tool: ${name}` };
  const input = def.input.safeParse(args ?? {});
  if (!input.success) return { ok: false, error: `Invalid arguments for ${name}: ${input.error.message}` };
  const cmd = StageCommand.safeParse({ cmd: name.slice("stage.".length), ...(input.data as object) });
  if (!cmd.success) return { ok: false, error: `Invalid stage command: ${cmd.error.message}` };
  let command = cmd.data;
  let note: string | undefined;
  if (stage.looksLocked()) {
    const fixed = "ok. The owner has fixed the look of the presence (style, colour and brightness), so that part was not changed.";
    if (command.cmd === "mood" && (command.accent !== undefined || command.intensity !== undefined)) return { ok: true, output: fixed, truncated: false };
    if (command.cmd === "presence" && command.style !== undefined) {
      const { style: _kept, ...rest } = command;
      if (rest.state === undefined) return { ok: true, output: fixed, truncated: false };
      command = rest;
      note = fixed;
    }
  }
  if (command.cmd === "show" && command.object.layer === "overlay" && !command.object.pinned) {
    // an overlay floats over everything: it takes no place on the stage and moves nothing
    command = { cmd: "show", object: { ...command.object, placement: "center" } };
  } else if (command.cmd === "show") {
    // never let a new object land on top of another one or on the always-visible parts of the screen
    const placed = placeObject(command.object, stage.snapshot().objects, stage.openPanels(), stage.screenInfo());
    command = { cmd: "show", object: placed.object };
    note = placed.note;
  }
  const applied = stage.apply(command);
  if (!applied.ok) return { ok: false, error: applied.error };
  emit({ type: "stage", command });
  for (const follow of applied.follow ?? []) emit({ type: "stage", command: follow });
  if (command.cmd === "clear") {
    const kept = stage.snapshot().objects.filter((o) => o.pinned).length;
    if (kept) note = `${kept} pinned widget${kept === 1 ? "" : "s"} stay${kept === 1 ? "s" : ""} on the screen (the owner keeps them).`;
  }
  return { ok: true, output: note ? `ok. ${note}` : "ok", truncated: false };
}
