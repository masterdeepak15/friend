import type { ScreenInfo, StageObject } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { describeZones, designFindings } from "./agent/compose";
import { StageState, runStageTool } from "./stage";

const DESKTOP: ScreenInfo = { width: 1920, height: 1080, kind: "desktop", orientation: "landscape", touch: false };
const PHONE: ScreenInfo = { width: 390, height: 844, kind: "phone", orientation: "portrait", touch: true };
const o = (id: string, extra: Partial<StageObject> = {}): StageObject => ({ id, type: "card", props: { text: id }, placement: "auto", ...extra });
const FOCUS_BOX = { x: 0.26, y: 0.12, w: 0.48, h: 0.56 };

describe("designFindings", () => {
  it("is silent for a clean desktop composition", () => {
    const objects = [o("f", { role: "focus", placement: FOCUS_BOX }), o("b", { role: "beside" }), o("c", { role: "glance", docked: true })];
    expect(designFindings(objects, DESKTOP)).toEqual([]);
  });
  it("says when nothing is the main thing", () => {
    expect(designFindings([o("a"), o("b")], DESKTOP).join(" ")).toMatch(/no focus/i);
  });
  it("does not ask for a focus when there is one thing, or when everything is put away", () => {
    expect(designFindings([o("a")], DESKTOP)).toEqual([]);
    expect(designFindings([o("a", { docked: true }), o("b", { docked: true })], DESKTOP)).toEqual([]);
  });
  it("says when more is shown than the screen shows well", () => {
    const many = [o("f", { role: "focus", placement: FOCUS_BOX }), ...["b1", "b2", "b3", "b4"].map((id) => o(id, { role: "beside" }))];
    expect(designFindings(many, DESKTOP).join(" ")).toMatch(/5 things.*desktop.*4/);
    expect(designFindings([o("f", { role: "focus" }), o("b1", { role: "beside" }), o("b2", { role: "beside" })], PHONE).join(" ")).toMatch(/phone/);
  });
  it("says when the focus is small", () => {
    const small = [o("f", { role: "focus", placement: { x: 0.4, y: 0.3, w: 0.2, h: 0.2 } }), o("b", { role: "beside" })];
    expect(designFindings(small, DESKTOP).join(" ")).toMatch(/focus "f" is small/i);
  });
  it("leaves pinned widgets and passing notes out of the count", () => {
    const objects = [o("f", { role: "focus", placement: FOCUS_BOX }), o("w1", { pinned: true }), o("w2", { pinned: true }), o("n", { layer: "overlay", role: "note" })];
    expect(designFindings(objects, DESKTOP)).toEqual([]);
  });
});

describe("the screen description", () => {
  it("lists the free zones and the chips, and still lists the free regions", () => {
    const s = new StageState();
    s.setScreen(DESKTOP);
    runStageTool("screen.compose", { items: [{ id: "t", type: "stat", props: { label: "Temp", value: 24, unit: "C" }, role: "glance" }, { id: "f", type: "card", props: { text: "hi" }, role: "focus" }] }, s, () => {});
    const text = s.summary(0);
    expect(text).toMatch(/zones: .*focus taken.*beside 3 of 3 free/);
    expect(text).toMatch(/chips \(1 of 7\): Temp 24 C/);
    expect(text).toMatch(/free regions:/);
  });
  it("says a phone stacks", () => {
    const s = new StageState();
    s.setScreen(PHONE);
    expect(s.summary(0)).toMatch(/zones: stacked/);
    expect(s.summary(0)).not.toMatch(/free regions/);
  });
  it("describeZones says an empty desktop has everything free", () => {
    expect(describeZones({ screen: DESKTOP, panels: [], instruments: [], current: [], ownerPlaced: new Set() })).toBe("zones: focus free, beside 3 of 3 free; chips (0 of 7): none");
  });
});
