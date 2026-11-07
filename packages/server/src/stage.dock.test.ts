import { describe, expect, it } from "vitest";
import { StageState } from "./stage";

const show = (s: StageState, id: string, extra: object = {}) =>
  s.apply({ cmd: "show", object: { id, type: "card", props: { text: id }, placement: "auto", ...extra } });

describe("StageState docks and undocks objects", () => {
  it("marks one object docked and brings it back", () => {
    const s = new StageState();
    show(s, "a");
    show(s, "b");
    expect(s.apply({ cmd: "dock", id: "a", docked: true })).toEqual({ ok: true });
    expect(s.snapshot().objects.find((o) => o.id === "a")?.docked).toBe(true);
    expect(s.snapshot().objects.find((o) => o.id === "b")?.docked).toBeUndefined();
    s.apply({ cmd: "dock", id: "a", docked: false });
    expect(s.snapshot().objects.find((o) => o.id === "a")).not.toHaveProperty("docked");
  });
  it("refuses an unknown id", () => {
    expect(new StageState().apply({ cmd: "dock", id: "zz", docked: true })).toMatchObject({ ok: false });
  });
  it("never docks a pinned widget on the assistant's say-so", () => {
    const s = new StageState();
    show(s, "w", { pinned: true });
    expect(s.apply({ cmd: "dock", id: "w", docked: true })).toMatchObject({ ok: false });
  });
});
