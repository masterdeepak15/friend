import type { Audit } from "./audit";
import type { Eye } from "./eye";

export type LookTool = "camera.snap" | "camera.watch";
export const LOOK_TOOLS: ReadonlySet<string> = new Set<LookTool>(["camera.snap", "camera.watch"]);

/** Fixed limits: they are not settings, so nothing the assistant is told can raise them. */
export const MAX_LOOKS_PER_HOUR = 20;
export const MAX_CLIP_SECONDS_PER_HOUR = 30;
const HOUR_MS = 3_600_000;

/** Where a request is typed or spoken at the Friend screen. Everything else (a channel, the Office, a schedule, Alexa) is somewhere else. */
const SCREEN_SOURCES = new Set(["chat", "voice"]);

/**
 * The source of a spoken request. A voice that was recognised as the owner's counts as the owner at the screen; a voice that could not be
 * checked (no voice has been saved yet) does not, so a visitor's words never make the camera open or an introduction happen.
 */
export const voiceTurnSource = (verified: boolean): "voice" | "voice-unverified" => (verified ? "voice" : "voice-unverified");

export type GateAnswer = { allow: true } | { allow: false; reason: string };

/**
 * Decides whether a look through the camera may go ahead without the approval card. It reads only what the server knows (is the eye
 * on, who is asking and from where, how many looks there were), never anything the assistant or a picture says. When it says no,
 * the old rule stands: the owner is asked.
 */
export class EyeGate {
  private looks: number[] = [];
  private clips: { at: number; seconds: number }[] = [];

  constructor(private d: { eye: Pick<Eye, "isOn">; clock?: () => number; audit: Pick<Audit, "log"> }) {}

  decide(tool: LookTool | string, ctx: { trust: string; source?: string }, seconds = 0): GateAnswer {
    if (!this.d.eye.isOn()) return { allow: false, reason: "The eye is off." };
    const refuse = (reason: string): GateAnswer => {
      this.d.audit.log("agent", "camera.look.refused", { tool, reason, trust: ctx.trust, source: ctx.source ?? "unknown" });
      return { allow: false, reason };
    };
    if (ctx.trust !== "owner") return refuse("Only the owner may use the eye.");
    if (!ctx.source || !SCREEN_SOURCES.has(ctx.source)) return refuse("The eye works only when the owner talks to Friend at the screen.");
    const now = (this.d.clock ?? Date.now)();
    this.looks = this.looks.filter((t) => now - t < HOUR_MS);
    this.clips = this.clips.filter((c) => now - c.at < HOUR_MS);
    if (this.looks.length >= MAX_LOOKS_PER_HOUR) return refuse(`That is ${MAX_LOOKS_PER_HOUR} looks in the last hour.`);
    const used = this.clips.reduce((s, c) => s + c.seconds, 0);
    if (seconds > 0 && used + seconds > MAX_CLIP_SECONDS_PER_HOUR) return refuse(`That would be more than ${MAX_CLIP_SECONDS_PER_HOUR} seconds of video in the last hour.`);
    this.looks.push(now);
    if (seconds > 0) this.clips.push({ at: now, seconds });
    this.d.audit.log("agent", "camera.look", { tool, seconds, source: ctx.source });
    return { allow: true };
  }
}
