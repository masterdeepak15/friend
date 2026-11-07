import { describe, expect, it } from "vitest";
import { EyeGate, MAX_CLIP_SECONDS_PER_HOUR, MAX_LOOKS_PER_HOUR } from "./eyeGate";

function rig(on = true) {
  const log: { kind: string; detail: Record<string, unknown> }[] = [];
  let now = 5_000_000;
  const state = { on };
  const gate = new EyeGate({
    eye: { isOn: () => state.on },
    clock: () => now,
    audit: { log: ((_who: string, kind: string, detail: Record<string, unknown>) => void log.push({ kind, detail })) as never },
  });
  return { gate, log, state, advance: (ms: number) => (now += ms) };
}
const screen = { trust: "owner", source: "chat" };

describe("EyeGate: who may look without a card", () => {
  it("lets the owner look from the chat and from the voice at the screen, when the eye is on", () => {
    const r = rig();
    expect(r.gate.decide("camera.snap", screen)).toEqual({ allow: true });
    expect(r.gate.decide("camera.snap", { trust: "owner", source: "voice" })).toEqual({ allow: true });
    expect(r.log.map((l) => l.kind)).toEqual(["camera.look", "camera.look"]);
    expect(r.log[0]!.detail).toMatchObject({ tool: "camera.snap", source: "chat" });
  });

  it("asks (and writes nothing) when the eye is off", () => {
    const r = rig(false);
    expect(r.gate.decide("camera.snap", screen)).toMatchObject({ allow: false });
    expect(r.log).toEqual([]);
  });

  it.each([
    ["Telegram or WhatsApp", { trust: "owner", source: "channel" }],
    ["the Office", { trust: "owner", source: "office" }],
    ["a scheduled task", { trust: "owner", source: "task" }],
    ["a guest", { trust: "guest", source: "voice" }],
    ["a household member", { trust: "member", source: "voice" }],
    ["Alexa", { trust: "voice-device", source: undefined }],
    ["a turn with no known origin", { trust: "owner", source: undefined }],
  ])("keeps asking for %s, and writes the refusal down", (_who, ctx) => {
    const r = rig();
    expect(r.gate.decide("camera.snap", ctx)).toMatchObject({ allow: false });
    expect(r.log).toHaveLength(1);
    expect(r.log[0]!.kind).toBe("camera.look.refused");
  });

  it(`stops after ${MAX_LOOKS_PER_HOUR} looks in an hour, and starts again an hour later`, () => {
    const r = rig();
    for (let i = 0; i < MAX_LOOKS_PER_HOUR; i++) expect(r.gate.decide("camera.snap", screen)).toEqual({ allow: true });
    expect(r.gate.decide("camera.snap", screen)).toMatchObject({ allow: false, reason: expect.stringMatching(/20 looks/) });
    r.advance(61 * 60_000);
    expect(r.gate.decide("camera.snap", screen)).toEqual({ allow: true });
  });

  it(`stops after ${MAX_CLIP_SECONDS_PER_HOUR} seconds of clip in an hour`, () => {
    const r = rig();
    expect(r.gate.decide("camera.watch", screen, 10)).toEqual({ allow: true });
    expect(r.gate.decide("camera.watch", screen, 10)).toEqual({ allow: true });
    expect(r.gate.decide("camera.watch", screen, 10)).toEqual({ allow: true });
    expect(r.gate.decide("camera.watch", screen, 1)).toMatchObject({ allow: false, reason: expect.stringMatching(/30 seconds/) });
    expect(r.gate.decide("camera.snap", screen)).toEqual({ allow: true }); // a single picture is not clip time
  });

  it("never records a picture, only that a look happened", () => {
    const r = rig();
    r.gate.decide("camera.snap", screen);
    expect(JSON.stringify(r.log)).not.toMatch(/base64|jpeg|data/i);
  });
});
