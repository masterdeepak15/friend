import { z } from "zod";
import { StageCommand, StageSnapshot } from "./stage";
import { Tier } from "./tiers";

/** How much the owner wants on the screen besides the AI's own pictures. */
export const ViewPreset = z.enum(["minimal", "companion", "workspace"]);
export type ViewPreset = z.infer<typeof ViewPreset>;

/** How the owner wants the voice presence and captions to look on the screen (style, colour and glow travel as stage state). */
export const ClientLook = z.object({
  /** Size of the presence in the middle of the screen, 0.5 (small) to 1.5 (large). */
  size: z.number().min(0.5).max(1.5),
  /** How strongly it reacts to voice, 0 (barely) to 1 (a lot). */
  reactivity: z.number().min(0).max(1),
  /** The soft glow behind everything. */
  ambient: z.boolean(),
  captions: z.boolean(),
  captionSize: z.enum(["small", "medium", "large"]),
});
export type ClientLook = z.infer<typeof ClientLook>;

const ScreenInfoShape = {
  width: z.number().int().min(100).max(10000),
  height: z.number().int().min(100).max(10000),
  kind: z.enum(["phone", "tablet", "desktop"]),
  orientation: z.enum(["portrait", "landscape"]),
  /** The main pointer is a finger. */
  touch: z.boolean(),
};
export const ScreenInfo = z.object(ScreenInfoShape);
export type ScreenInfo = z.infer<typeof ScreenInfo>;

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
  /** What the owner just said or typed, so every open screen can show the conversation. */
  z.object({ type: z.literal("chat.user"), text: z.string() }),
  /** The owner's chosen view (sent on connect and whenever it changes). */
  z.object({ type: z.literal("ui"), view: ViewPreset, look: ClientLook.optional(), ownerName: z.string().max(40).optional() }),
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
    /** owner: the voice matched; member: a person of the household matched; guest: it did not; unverified: no voice is enrolled yet. */
    trust: z.enum(["owner", "guest", "unverified", "member"]).optional(),
    /** Who is speaking, when the voice matched a person of the household. */
    speaker: z.string().max(60).optional(),
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
  /** The owner approved a look at the screen: draw this page into a picture and upload it. */
  z.object({ type: z.literal("screen.request"), id: z.string() }),
  z.object({ type: z.literal("screen.cancel"), id: z.string() }),
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
  z.object({ type: z.literal("screen.denied"), id: z.string(), reason: z.enum(["unsupported", "failed", "busy"]) }),
  /** Which side panels the owner has open, so the AI keeps its pictures out of their way. */
  z.object({ type: z.literal("ui.panels"), open: z.array(z.enum(["chat", "tasks"])).max(2) }),
  /** What this screen is: its size in CSS pixels, the kind of device, and how it is held, so the AI can lay things out for it. */
  z.object({ type: z.literal("ui.screen"), ...ScreenInfoShape }),
  /** The owner dragged or resized an object (fractions of the screen, 0..1). */
  z.object({ type: z.literal("stage.move"), objectId: z.string().max(64), rect: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1), w: z.number().min(0).max(1), h: z.number().min(0).max(1) }) }),
  /** The owner pinned an object as a widget, or unpinned it. */
  z.object({ type: z.literal("stage.pin"), objectId: z.string().max(64), pinned: z.boolean() }),
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
