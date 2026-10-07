import { describe, expect, it } from "vitest";
import { Placement, PresenceStyle, StageCommand, StageObject, StageSnapshot } from "./index";

const base = { id: "a", props: {}, placement: "auto" as const };

describe("phase 2a stage vocabulary", () => {
  it("accepts the auto placement", () => {
    expect(Placement.safeParse("auto").success).toBe(true);
  });
  it.each(["chart", "gauge", "timeline", "graph"])("accepts object type %s", (type) => {
    expect(StageObject.safeParse({ ...base, type }).success).toBe(true);
  });
  it("still rejects unknown object types", () => {
    expect(StageObject.safeParse({ ...base, type: "map" }).success).toBe(false);
  });
  it.each(["sphere", "orb", "ring"])("accepts presence style %s", (style) => {
    expect(PresenceStyle.safeParse(style).success).toBe(true);
    expect(StageCommand.safeParse({ cmd: "presence", style }).success).toBe(true);
  });
  it("rejects an unknown presence style in commands and snapshots", () => {
    expect(StageCommand.safeParse({ cmd: "presence", style: "hologram" }).success).toBe(false);
    const snap = {
      scene: "conversation",
      objects: [],
      presence: { state: "idle", style: "hologram" },
      mood: { accent: "#fff", intensity: 0.5 },
    };
    expect(StageSnapshot.safeParse(snap).success).toBe(false);
  });
});
