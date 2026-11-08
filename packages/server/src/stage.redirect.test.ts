import { overlap, rectOf, type Rect, type ServerMsg } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { StageState, runStageTool } from "./stage";

const DESKTOP = { width: 1920, height: 855, kind: "desktop" as const, orientation: "landscape" as const, touch: false };
const run = (stage: StageState, name: string, args: unknown) => runStageTool(name, args, stage, (_m: ServerMsg) => {});
const obj = (stage: StageState, id: string) => stage.snapshot().objects.find((o) => o.id === id);
const box = (stage: StageState, id: string): Rect => rectOf(obj(stage, id)!.placement)!;
const composed = () => {
  const stage = new StageState();
  stage.setScreen(DESKTOP);
  run(stage, "screen.compose", { mode: "replace", items: [{ id: "chart", type: "card", props: { title: "Chart", text: "main" }, role: "focus" }, { id: "kv", type: "card", props: { title: "Side", text: "side" }, role: "beside" }] });
  return stage;
};

describe("once a screen is composed, stage.show goes through the director", () => {
  it("a new card is added beside the focus in a free place, whatever place it asked for", () => {
    const stage = composed();
    const r = run(stage, "stage.show", { object: { id: "extra", type: "card", props: { text: "more" }, placement: "center" } });
    expect(r.ok).toBe(true);
    expect(obj(stage, "extra")).toMatchObject({ role: "beside" });
    if (!obj(stage, "extra")!.docked) {
      expect(overlap(box(stage, "extra"), box(stage, "chart"))).toBeLessThan(0.01);
      expect(overlap(box(stage, "extra"), box(stage, "kv"))).toBeLessThan(0.01);
    }
    expect((r as { output: string }).output).toMatch(/screen\.compose/);
  });

  it("showing the focus again with a huge box keeps its place and role, and only its content changes", () => {
    const stage = composed();
    const before = box(stage, "chart");
    run(stage, "stage.show", { object: { id: "chart", type: "card", props: { title: "Chart", text: "changed" }, placement: { x: 0, y: 0, w: 1, h: 1 } } });
    expect(obj(stage, "chart")).toMatchObject({ role: "focus", props: { text: "changed" } });
    expect(box(stage, "chart")).toEqual(before);
  });

  it("a placement of auto does not fill the screen", () => {
    const stage = composed();
    run(stage, "stage.show", { object: { id: "extra", type: "card", props: { text: "more" }, placement: "auto" } });
    expect(obj(stage, "extra")!.placement).not.toBe("auto");
  });

  it("without a composed screen stage.show works as before", () => {
    const stage = new StageState();
    stage.setScreen(DESKTOP);
    run(stage, "stage.show", { object: { id: "a", type: "card", props: { text: "x" }, placement: "center" } });
    expect(obj(stage, "a")!.role).toBeUndefined();
    expect(obj(stage, "a")!.placement).toBe("center");
  });

  it("an overlay explanation is untouched", () => {
    const stage = composed();
    run(stage, "stage.show", { object: { id: "why", type: "card", props: { text: "because" }, placement: "center", layer: "overlay" } });
    expect(obj(stage, "why")).toMatchObject({ layer: "overlay" });
    expect(obj(stage, "why")!.role).toBeUndefined();
  });
});
