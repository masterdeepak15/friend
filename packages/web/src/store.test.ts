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
