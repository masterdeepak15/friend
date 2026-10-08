import type { ServerMsg } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "./store";

const card = (id: string) => ({ id, type: "card" as const, props: { text: id }, placement: "center" as const });
const snapshot: ServerMsg = {
  type: "snapshot",
  stage: {
    scene: "multi",
    objects: [card("a"), card("b")],
    presence: { state: "thinking", style: "sphere" },
    mood: { accent: "#ffb454", intensity: 0.4 },
  },
  pendingApproval: { id: "ap1", tool: "shell.run", summary: "Run shell command: dir", tier: "T2", needsPin: false },
};

describe("reduce", () => {
  it("replaces stage and approval from a snapshot", () => {
    const s = reduce({ ...initialState, objects: [card("old")] }, snapshot);
    expect(s.scene).toBe("multi");
    expect(s.objects.map((o) => o.id)).toEqual(["a", "b"]);
    expect(s.presence.state).toBe("thinking");
    expect(s.mood.accent).toBe("#ffb454");
    expect(s.approval?.id).toBe("ap1");
  });

  it("applies show, update, hide, clear, scene, presence and mood commands", () => {
    let s = reduce(initialState, { type: "stage", command: { cmd: "show", object: card("a") } });
    s = reduce(s, { type: "stage", command: { cmd: "show", object: card("b") } });
    expect(s.objects.map((o) => o.id)).toEqual(["a", "b"]);
    s = reduce(s, { type: "stage", command: { cmd: "show", object: { ...card("a"), props: { text: "new" } } } });
    expect(s.objects).toHaveLength(2);
    expect(s.objects[0]!.props).toEqual({ text: "new" });
    s = reduce(s, { type: "stage", command: { cmd: "update", id: "b", props: { extra: 1 } } });
    expect(s.objects[1]!.props).toEqual({ text: "b", extra: 1 });
    s = reduce(s, { type: "stage", command: { cmd: "hide", id: "a" } });
    expect(s.objects.map((o) => o.id)).toEqual(["b"]);
    s = reduce(s, { type: "stage", command: { cmd: "scene", mode: "focus" } });
    expect(s.scene).toBe("focus");
    s = reduce(s, { type: "stage", command: { cmd: "presence", state: "speaking" } });
    expect(s.presence.state).toBe("speaking");
    s = reduce(s, { type: "stage", command: { cmd: "mood", accent: "#fff", intensity: 1 } });
    expect(s.mood).toEqual({ accent: "#fff", intensity: 1 });
    s = reduce(s, { type: "stage", command: { cmd: "clear" } });
    expect(s.objects).toEqual([]);
    expect(s.scene).toBe("conversation");
  });

  it("accumulates caption deltas, marks them complete, and starts fresh on the next turn", () => {
    let s = reduce(initialState, { type: "caption.delta", text: "Hel" });
    s = reduce(s, { type: "caption.delta", text: "lo" });
    expect(s.captions).toBe("Hello");
    expect(s.captionDone).toBe(false);
    expect(s.presence.amplitude).toBeGreaterThan(0);
    s = reduce(s, { type: "caption.end" });
    expect(s.captionDone).toBe(true);
    expect(s.presence.amplitude).toBe(0);
    s = reduce(s, { type: "caption.delta", text: "Next" });
    expect(s.captions).toBe("Next");
  });

  it("increments pulse on every caption delta even when the amplitude is equal", () => {
    let s = reduce(initialState, { type: "caption.delta", text: "abcd" });
    const first = s.presence.pulse;
    s = reduce(s, { type: "caption.delta", text: "wxyz" });
    expect(s.presence.amplitude).toBe(reduce(initialState, { type: "caption.delta", text: "abcd" }).presence.amplitude);
    expect(s.presence.pulse).toBe(first + 1);
  });

  it("tracks voice availability from status and keeps it when status omits the field", () => {
    expect(initialState.voice).toEqual({ mode: "idle", level: 0, available: false, enrolled: false });
    let s = reduce(initialState, { type: "status", busy: false, deviceOnline: true, voiceAvailable: true });
    expect(s.voice.available).toBe(true);
    s = reduce(s, { type: "status", busy: false, deviceOnline: true });
    expect(s.voice.available).toBe(true);
    s = reduce(s, { type: "status", busy: false, deviceOnline: true, voiceAvailable: false });
    expect(s.voice.available).toBe(false);
  });

  it("adds local alerts for things the browser itself notices", () => {
    const s = reduce(initialState, { type: "alert.add", level: "warn", text: "Microphone permission was denied." });
    expect(s.alerts).toHaveLength(1);
    expect(s.alerts[0]).toMatchObject({ level: "warn", text: "Microphone permission was denied." });
  });

  it("applies local voice mode and level actions, clamping the level", () => {
    let s = reduce(initialState, { type: "voice.mode", mode: "listening" });
    expect(s.voice.mode).toBe("listening");
    s = reduce(s, { type: "voice.level", level: 0.4 });
    expect(s.voice.level).toBe(0.4);
    s = reduce(s, { type: "voice.level", level: 7 });
    expect(s.voice.level).toBe(1);
    s = reduce(s, { type: "voice.level", level: Number.NaN });
    expect(s.voice.level).toBe(0);
    s = reduce(s, { type: "voice.mode", mode: "idle" });
    expect(s.voice).toMatchObject({ mode: "idle", level: 0 });
  });

  it("tracks whether a voice is enrolled from status and keeps it when status omits the field", () => {
    let s = reduce(initialState, { type: "status", busy: false, deviceOnline: true, voiceEnrolled: true });
    expect(s.voice.enrolled).toBe(true);
    s = reduce(s, { type: "status", busy: false, deviceOnline: true });
    expect(s.voice.enrolled).toBe(true);
    s = reduce(s, { type: "status", busy: false, deviceOnline: true, voiceEnrolled: false });
    expect(s.voice.enrolled).toBe(false);
  });

  it("labels what an unrecognized voice said as a guest", () => {
    expect(reduce(initialState, { type: "voice.heard", text: "open it", trust: "guest" }).captions).toBe("Guest: open it");
    expect(reduce(initialState, { type: "voice.heard", text: "open it", trust: "owner" }).captions).toBe("open it");
    expect(reduce(initialState, { type: "voice.heard", text: "open it", trust: "unverified" }).captions).toBe("open it");
  });

  it("holds a pending voice challenge until it ends, is dismissed, or is replaced", () => {
    expect(initialState.challenge).toBeNull();
    let s = reduce(initialState, { type: "voice.challenge", id: "c1", text: "open the garage" });
    expect(s.challenge).toEqual({ id: "c1", text: "open the garage" });
    s = reduce(s, { type: "voice.challenge.end", id: "other" });
    expect(s.challenge?.id).toBe("c1");
    s = reduce(s, { type: "voice.challenge", id: "c2", text: "second" });
    expect(s.challenge?.id).toBe("c2");
    expect(reduce(s, { type: "voice.challenge.end", id: "c2" }).challenge).toBeNull();
    expect(reduce(s, { type: "challenge.dismiss", id: "c2" }).challenge).toBeNull();
    expect(reduce(s, { type: "challenge.dismiss", id: "old" }).challenge?.id).toBe("c2");
  });

  it("shows what the owner said as a caption", () => {
    const s = reduce(initialState, { type: "voice.heard", text: "open the garage" });
    expect(s.captions).toBe("open the garage");
    expect(reduce(s, { type: "caption.delta", text: "Opening." }).captions).toBe("Opening.");
  });

  it("keeps amplitude within 0..1", () => {
    const s = reduce(initialState, { type: "caption.delta", text: "x".repeat(500) });
    expect(s.presence.amplitude).toBeLessThanOrEqual(1);
  });

  it("sets the approval on request and clears it when resolved", () => {
    let s = reduce(initialState, { type: "approval.request", id: "x", tool: "shell.run", summary: "s", tier: "T3", needsPin: true });
    expect(s.approval).toMatchObject({ id: "x", needsPin: true });
    s = reduce(s, { type: "approval.resolved", id: "other" });
    expect(s.approval?.id).toBe("x");
    s = reduce(s, { type: "approval.resolved", id: "x" });
    expect(s.approval).toBeNull();
  });

  it("records alerts and lets them be dismissed", () => {
    let s = reduce(initialState, { type: "alert", level: "warn", text: "Incorrect PIN" });
    expect(s.alerts).toHaveLength(1);
    s = reduce(s, { type: "alert.dismiss", id: s.alerts[0]!.id });
    expect(s.alerts).toEqual([]);
  });

  it("tracks connection and status", () => {
    let s = reduce(initialState, { type: "conn", value: "open" });
    expect(s.connection).toBe("open");
    s = reduce(s, { type: "status", busy: true, deviceOnline: true });
    expect(s.busy).toBe(true);
    expect(s.deviceOnline).toBe(true);
  });

  it("ignores invalid messages without throwing", () => {
    expect(reduce(initialState, { type: "nonsense" })).toBe(initialState);
    expect(reduce(initialState, null)).toBe(initialState);
    expect(reduce(initialState, { type: "stage", command: { cmd: "show", object: { id: 1 } } })).toBe(initialState);
  });
});
