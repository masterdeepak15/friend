import { z } from "zod";
import { StageCommand, StageSnapshot } from "./stage";
import { Tier } from "./tiers";

export const PendingApproval = z.object({
  id: z.string(),
  tool: z.string(),
  summary: z.string(),
  tier: Tier,
  needsPin: z.boolean(),
});
export type PendingApproval = z.infer<typeof PendingApproval>;

export const ServerMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("stage"), command: StageCommand }),
  z.object({ type: z.literal("caption.delta"), text: z.string() }),
  z.object({ type: z.literal("caption.end") }),
  z.object({ type: z.literal("approval.request") }).merge(PendingApproval),
  z.object({ type: z.literal("approval.resolved"), id: z.string() }),
  z.object({ type: z.literal("alert"), level: z.enum(["info", "warn", "error"]), text: z.string() }),
  z.object({
    type: z.literal("status"),
    busy: z.boolean(),
    deviceOnline: z.boolean(),
    voiceAvailable: z.boolean().optional(),
    message: z.string().optional(),
  }),
  z.object({ type: z.literal("voice.heard"), text: z.string() }),
  z.object({
    type: z.literal("audio.chunk"),
    id: z.string(),
    seq: z.number().int().min(0),
    last: z.boolean(),
    mime: z.string(),
    data: z.string(),
  }),
  z.object({ type: z.literal("audio.stop") }),
  z.object({ type: z.literal("snapshot"), stage: StageSnapshot, pendingApproval: PendingApproval.nullable().optional() }),
  z.object({ type: z.literal("error"), message: z.string() }),
]);
export type ServerMsg = z.infer<typeof ServerMsg>;

export const ApprovalRespond = z.object({
  type: z.literal("approval.respond"),
  id: z.string(),
  decision: z.enum(["approve", "deny", "approve_always"]),
  pin: z.string().max(32).optional(),
});
export type ApprovalRespond = z.infer<typeof ApprovalRespond>;

export const ClientMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("chat.send"), text: z.string().min(1).max(8000) }),
  z.object({ type: z.literal("stage.event"), objectId: z.string(), event: z.string().max(64) }),
  ApprovalRespond,
  z.object({ type: z.literal("voice.interrupt") }),
  z.object({ type: z.literal("ping") }),
]);
export type ClientMsg = z.infer<typeof ClientMsg>;

export const DeviceDown = z.object({
  type: z.literal("tool.exec"),
  id: z.string(),
  tool: z.string(),
  args: z.unknown(),
  approvedOutside: z.boolean().optional(),
});
export type DeviceDown = z.infer<typeof DeviceDown>;

export const DeviceUp = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool.result"), id: z.string(), result: z.object({ output: z.string(), truncated: z.boolean() }) }),
  z.object({ type: z.literal("tool.error"), id: z.string(), error: z.string() }),
]);
export type DeviceUp = z.infer<typeof DeviceUp>;
