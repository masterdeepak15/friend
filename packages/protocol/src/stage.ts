import { z } from "zod";

const unit = z.number().min(0).max(1);

export const Placement = z.union([
  z.enum(["center", "left", "right", "top", "bottom"]),
  z.object({ x: unit, y: unit, w: unit, h: unit }),
]);
export type Placement = z.infer<typeof Placement>;

export const SceneMode = z.enum(["ambient", "conversation", "focus", "multi"]);
export type SceneMode = z.infer<typeof SceneMode>;

export const PresenceState = z.enum(["idle", "listening", "thinking", "speaking"]);
export type PresenceState = z.infer<typeof PresenceState>;

export const StageObject = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(["card", "stat", "list", "table", "code"]),
  props: z.record(z.string(), z.unknown()),
  placement: Placement,
  ttl: z.number().positive().max(3600).optional(),
  style: z.enum(["glass", "alert"]).optional(),
});
export type StageObject = z.infer<typeof StageObject>;

export const StageCommand = z.discriminatedUnion("cmd", [
  z.object({ cmd: z.literal("scene"), mode: SceneMode }),
  z.object({ cmd: z.literal("show"), object: StageObject }),
  z.object({ cmd: z.literal("update"), id: z.string(), props: z.record(z.string(), z.unknown()) }),
  z.object({ cmd: z.literal("hide"), id: z.string() }),
  z.object({ cmd: z.literal("clear") }),
  z.object({ cmd: z.literal("presence"), state: PresenceState.optional(), style: z.string().max(32).optional() }),
  z.object({ cmd: z.literal("mood"), accent: z.string().max(16).optional(), intensity: unit.optional() }),
]);
export type StageCommand = z.infer<typeof StageCommand>;

export const StageSnapshot = z.object({
  scene: SceneMode,
  objects: z.array(StageObject),
  presence: z.object({ state: PresenceState, style: z.string() }),
  mood: z.object({ accent: z.string(), intensity: unit }),
});
export type StageSnapshot = z.infer<typeof StageSnapshot>;
