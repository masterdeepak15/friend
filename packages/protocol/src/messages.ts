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
  /** What Friend is doing right now, in plain words (null when nothing). Shown in the corner of the screen. */
  z.object({ type: z.literal("activity"), text: z.string().max(80).nullable() }),
  z.object({
    type: z.literal("status"),
    busy: z.boolean(),
    deviceOnline: z.boolean(),
    voiceAvailable: z.boolean().optional(),
    /** Whether the owner's voice has been enrolled for speaker recognition. */
    voiceEnrolled: z.boolean().optional(),
    message: z.string().optional(),
  }),
  z.object({
    type: z.literal("voice.heard"),
    text: z.string(),
    /** owner: the voice matched; guest: it did not; unverified: no voice is enrolled yet. */
    trust: z.enum(["owner", "guest", "unverified"]).optional(),
  }),
  /** A borderline voice: nothing runs until the owner confirms with the PIN. */
  z.object({ type: z.literal("voice.challenge"), id: z.string(), text: z.string() }),
  z.object({ type: z.literal("voice.challenge.end"), id: z.string() }),
  z.object({
    type: z.literal("audio.chunk"),
    id: z.string(),
    seq: z.number().int().min(0),
    last: z.boolean(),
    mime: z.string(),
    data: z.string(),
  }),
  z.object({ type: z.literal("audio.stop") }),
  /** The owner approved a look through the camera: take one picture and upload it. */
  z.object({ type: z.literal("camera.request"), id: z.string() }),
  /** Stop: the request was answered elsewhere, timed out, or the emergency lock fired. */
  z.object({ type: z.literal("camera.cancel"), id: z.string() }),
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
  z.object({ type: z.literal("voice.confirm"), id: z.string(), pin: z.string().max(32) }),
  z.object({ type: z.literal("voice.cancel"), id: z.string() }),
  z.object({ type: z.literal("camera.denied"), id: z.string(), reason: z.enum(["off", "no-camera", "permission", "busy"]) }),
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
