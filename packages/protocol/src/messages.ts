import { z } from "zod";
import { parseRef } from "./musicRef";
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

/** One track as a screen needs it to show and play it (an id Friend made, never a path). */
export const MusicTrackRef = z.object({ id: z.string().refine((v) => parseRef(v) !== null, "A track id or a source:id ref"), title: z.string().max(200), artist: z.string().max(200), album: z.string().max(200), durationSec: z.number().nullable() });
export type MusicTrackRef = z.infer<typeof MusicTrackRef>;

/** What a screen reports about its player: what is playing, the queue, and whether this is the screen commands should reach. */
export const MusicState = z.object({
  playing: z.boolean(),
  trackId: z.string().max(80).nullable(),
  title: z.string().max(200),
  artist: z.string().max(200),
  album: z.string().max(200),
  position: z.number().min(0),
  duration: z.number().min(0),
  volume: z.number().min(0).max(100),
  muted: z.boolean(),
  shuffle: z.boolean(),
  repeat: z.enum(["off", "all", "one"]),
  view: z.enum(["mini", "full", "hidden"]),
  queue: z.array(z.object({ id: z.string().max(80), title: z.string().max(200) })).max(50),
  index: z.number().int().min(-1),
  active: z.boolean(),
});
export type MusicState = z.infer<typeof MusicState>;

/** What the assistant tells the player to do. Play carries the tracks (found by Friend); the rest are controls. */
export const MusicCommand = z.object({
  action: z.enum(["play", "pause", "resume", "toggle", "stop", "next", "previous", "seek", "volume", "mute", "shuffle", "repeat", "view", "queue.remove", "queue.clear", "jump"]),
  tracks: z.array(MusicTrackRef).max(500).optional(),
  /** For play: replace the queue, add to its end, or play next. For repeat: off, all or one. */
  mode: z.enum(["replace", "add", "next", "off", "all", "one"]).optional(),
  shuffle: z.boolean().optional(),
  seconds: z.number().min(0).optional(),
  percent: z.number().min(0).max(100).optional(),
  level: z.number().min(0).max(100).optional(),
  delta: z.number().min(-100).max(100).optional(),
  on: z.boolean().optional(),
  view: z.enum(["mini", "full", "hidden"]).optional(),
  index: z.number().int().min(0).optional(),
});
export type MusicCommand = z.infer<typeof MusicCommand>;

/** The screen widgets as a screen needs them (the owner's settings, with nothing private in them). */
export const HudView = z.object({
  terminalLabel: z.string().max(24),
  clock: z.object({ hour12: z.boolean(), seconds: z.boolean(), locale: z.string().max(35) }),
  launcher: z
    .array(z.object({ id: z.string().max(20), label: z.string().max(24), icon: z.string().max(16), action: z.object({ type: z.enum(["url", "prompt", "panel", "music"]), value: z.string().max(500) }) }))
    .max(12),
  animations: z.enum(["full", "reduced", "off"]),
});
export type HudView = z.infer<typeof HudView>;

/** The music player's settings as a screen needs them. The folder itself is not sent, only whether one is chosen. */
export const MusicView = z.object({ folderSet: z.boolean(), volume: z.number().min(0).max(100), shuffle: z.boolean(), repeat: z.enum(["off", "all", "one"]), visualizer: z.boolean(), startView: z.enum(["mini", "full"]), output: z.enum(["screen", "host"]).optional() });
export type MusicView = z.infer<typeof MusicView>;

export const ServerMsg = z.discriminatedUnion("type", [
  z.object({ type: z.literal("music.command") }).merge(MusicCommand),
  /** What the PC's own player is doing (sent to every screen while the output is the PC, so they can show it). */
  z.object({ type: z.literal("music.host"), state: MusicState }),
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
  z.object({ type: z.literal("ui"), view: ViewPreset, look: ClientLook.optional(), ownerName: z.string().max(40).optional(), assistantName: z.string().max(40).optional(), hud: HudView.optional(), music: MusicView.optional() }),
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
  /** How loud music and video should be while the owner talks or Friend speaks: 1 is as it is, 0.25 a quarter. */
  z.object({ type: z.literal("audio.duck"), level: z.number().min(0).max(1) }),
  /** The owner approved a look through the camera: take one picture and upload it. */
  z.object({ type: z.literal("camera.request"), id: z.string() }),
  /** Stop: the request was answered elsewhere, timed out, or the emergency lock fired. */
  z.object({ type: z.literal("camera.cancel"), id: z.string() }),
  /** The owner approved a look at the screen: draw this page into a picture and upload it. */
  /** Opens a panel on the owner's screen (the assistant sends it so the owner can finish a step, such as pasting a token). */
  z.object({ type: z.literal("ui.open"), panel: z.literal("plugins"), integration: z.string().max(40).optional() }),
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
  /** This screen is listening to the owner, or Friend is speaking on it (true), or neither (false). */
  z.object({ type: z.literal("audio.activity"), active: z.boolean() }),
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
  z.object({ type: z.literal("music.state"), state: MusicState }),
  /** A screen's button press for the PC's player (only used while the output is the PC). */
  z.object({ type: z.literal("music.remote"), command: MusicCommand }),
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
