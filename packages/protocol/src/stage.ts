import { z } from "zod";
import { JARVIS_TYPES } from "./jarvis";

const unit = z.number().min(0).max(1);

export const Placement = z.union([
  z.enum(["auto", "center", "left", "right", "top", "bottom"]),
  z.object({ x: unit, y: unit, w: unit, h: unit }),
]);
export type Placement = z.infer<typeof Placement>;

export const SceneMode = z.enum(["ambient", "conversation", "focus", "multi"]);
export type SceneMode = z.infer<typeof SceneMode>;

export const PresenceState = z.enum(["idle", "listening", "thinking", "speaking"]);
export type PresenceState = z.infer<typeof PresenceState>;

export const PresenceStyle = z.enum(["sphere", "orb", "ring"]);
export type PresenceStyle = z.infer<typeof PresenceStyle>;

/** The basic widgets, and then every Jarvis component by its own name (JStatCard, JGaugeChart, JButton, ...): they are all object types, none is a special case. */
export const BASIC_TYPES = [
  "card", "stat", "list", "table", "code", "chart", "gauge", "timeline", "graph", "sandbox",
  "markdown", "image", "video", "pdf", "gallery", "group", "tabs", "progress", "checklist", "countdown", "kv",
] as const;
export const OBJECT_TYPES = [...BASIC_TYPES, ...JARVIS_TYPES] as unknown as readonly [string, ...string[]];

export const StageObject = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(OBJECT_TYPES),
  props: z.record(z.string(), z.unknown()),
  placement: Placement,
  ttl: z.number().positive().max(3600).optional(),
  style: z.enum(["glass", "alert"]).optional(),
  /** "overlay": floats in the middle over a dimmed screen without moving anything, and goes away by itself. */
  layer: z.enum(["base", "overlay"]).optional(),
  /** A widget: it stays (and keeps the place the owner gave it) across refreshes, logins and restarts, until it is removed on purpose. */
  pinned: z.boolean().optional(),
});
export type StageObject = z.infer<typeof StageObject>;

export const StageCommand = z.discriminatedUnion("cmd", [
  z.object({ cmd: z.literal("scene"), mode: SceneMode }),
  z.object({ cmd: z.literal("show"), object: StageObject }),
  z.object({ cmd: z.literal("update"), id: z.string(), props: z.record(z.string(), z.unknown()) }),
  z.object({ cmd: z.literal("hide"), id: z.string() }),
  z.object({ cmd: z.literal("clear") }),
  /** Make a shown object a widget that stays, or let it go back to being a temporary picture. */
  z.object({ cmd: z.literal("pin"), id: z.string() }),
  z.object({ cmd: z.literal("unpin"), id: z.string() }),
  /** The owner moved or resized an object. */
  z.object({ cmd: z.literal("place"), id: z.string(), placement: Placement }),
  z.object({ cmd: z.literal("presence"), state: PresenceState.optional(), style: PresenceStyle.optional() }),
  z.object({ cmd: z.literal("mood"), accent: z.string().max(16).optional(), intensity: unit.optional() }),
]);
export type StageCommand = z.infer<typeof StageCommand>;

export const StageSnapshot = z.object({
  scene: SceneMode,
  objects: z.array(StageObject),
  presence: z.object({ state: PresenceState, style: PresenceStyle }),
  mood: z.object({ accent: z.string(), intensity: unit }),
});
export type StageSnapshot = z.infer<typeof StageSnapshot>;
