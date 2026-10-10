import { OBJECT_TYPES, TOOL_DEFS } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { OVERLAY_TTL_S, StageState, runStageTool } from "../stage";
import { GUIDE_TOPICS, screenGuide } from "./guide";
import { LAYOUT_GUIDE } from "./layout";

const obj = (id: string, extra: Record<string, unknown> = {}) => ({ id, type: "card" as const, props: { text: id }, placement: "left" as const, ...extra });

describe("the screen manual", () => {
  it("describes every widget the screen can draw, with its props", () => {
    const widgets = screenGuide("widgets");
    for (const type of OBJECT_TYPES) expect(widgets, `the manual must mention ${type}`).toMatch(new RegExp(`\\b${type}\\b`));
    expect(widgets).toMatch(/group \{title\?, layout\?/);
    expect(widgets).toMatch(/var\(--accent\)/);
  });

  it("has a section for each topic, and 'all' has them all", () => {
    for (const topic of GUIDE_TOPICS.filter((t) => t !== "all")) expect(screenGuide(topic).length).toBeGreaterThan(200);
    const all = screenGuide();
    for (const topic of GUIDE_TOPICS.filter((t) => t !== "all")) expect(all).toContain(screenGuide(topic));
  });

  it("tells the AI what to do when the screen already has things on it", () => {
    const overlay = screenGuide("overlay");
    expect(overlay).toMatch(/layer "overlay"/);
    expect(overlay).toMatch(/stage\.clear/);
    expect(overlay).toMatch(/IMPORTANT/);
    expect(overlay).toMatch(/Never put an overlay on top of an overlay/);
  });

  it("is a tool the AI can call, with no approval, and the short rules in the prompt point to it", () => {
    const tool = TOOL_DEFS.find((t) => t.name === "stage.guide")!;
    expect(tool.baseTier).toBe("T0");
    expect(LAYOUT_GUIDE).toMatch(/stage\.guide/);
    expect(LAYOUT_GUIDE).toMatch(/layer "overlay"/);
    const out = runStageTool("stage.guide", { topic: "overlay" }, new StageState(), () => {});
    expect(out).toMatchObject({ ok: true });
    expect(runStageTool("stage.guide", {}, new StageState(), () => {})).toMatchObject({ ok: true, output: screenGuide("all") });
    expect(runStageTool("stage.guide", { topic: "nope" }, new StageState(), () => {})).toMatchObject({ ok: false });
  });
});

describe("overlay objects on the stage", () => {
  const show = (stage: StageState, o: Record<string, unknown>, emitted: unknown[] = []) => runStageTool("stage.show", { object: o }, stage, (m) => emitted.push(m));

  it("takes the middle without moving what is underneath", () => {
    const stage = new StageState();
    show(stage, obj("widget"));
    const before = stage.snapshot().objects.find((o) => o.id === "widget")!.placement;
    const out = show(stage, obj("why", { layer: "overlay", placement: "left" }));
    expect(out.ok).toBe(true);
    const objs = stage.snapshot().objects;
    expect(objs.find((o) => o.id === "why")).toMatchObject({ layer: "overlay", placement: "center" });
    expect(objs.find((o) => o.id === "widget")!.placement).toEqual(before);
  });

  it("goes away by itself after the default time, or the time it was given", () => {
    const stage = new StageState();
    stage.apply({ cmd: "show", object: { ...obj("a"), layer: "overlay" } }, 1_000);
    stage.apply({ cmd: "show", object: { ...obj("b"), layer: "overlay", ttl: 90 } }, 1_000);
    expect(stage.summary(1_000 + 1000)).toMatch(/a \(card, overlay on top, leaves in 29s\)/);
    expect(stage.summary(1_000 + 1000)).toMatch(/b \(card, overlay on top, leaves in 89s\)/);
    expect(stage.expire(1_000 + (OVERLAY_TTL_S + 1) * 1000)).toEqual(["a"]); // the one with the default time; the longer one stays
  });

  it("is not remembered as a widget when it is pinned: a pinned overlay is just a widget", () => {
    const stage = new StageState();
    stage.apply({ cmd: "show", object: { ...obj("keep"), layer: "overlay", pinned: true } });
    const kept = stage.snapshot().objects.find((o) => o.id === "keep")!;
    expect(kept.pinned).toBe(true);
    expect(kept.layer).toBeUndefined();
    expect(stage.summary(0)).not.toMatch(/keep \(card, overlay on top/);
  });

  it("does not use up a region of the stage", () => {
    const stage = new StageState();
    show(stage, obj("why", { layer: "overlay", placement: "center" }));
    expect(stage.summary(0)).toMatch(/free regions: center, left, right, top, bottom/);
  });
});
