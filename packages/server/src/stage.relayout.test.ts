import type { ScreenInfo } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { StageState, runStageTool } from "./stage";

const DESKTOP: ScreenInfo = { width: 1920, height: 1080, kind: "desktop", orientation: "landscape", touch: false };
const PHONE: ScreenInfo = { width: 390, height: 844, kind: "phone", orientation: "portrait", touch: true };
const item = (id: string, role: string) => ({ id, type: "card", props: { title: id, text: id }, role });
const shownIds = (s: StageState) => s.snapshot().objects.filter((o) => !o.docked).map((o) => o.id).sort();
const dockedIds = (s: StageState) => s.snapshot().objects.filter((o) => o.docked).map((o) => o.id).sort();

describe("the screen changes kind while things are shown", () => {
  it("desktop to phone: the focus and one card stay, the others become chips, nothing is lost", () => {
    const s = new StageState();
    s.setScreen(DESKTOP);
    runStageTool("screen.compose", { items: [item("f", "focus"), item("b1", "beside"), item("b2", "beside"), item("b3", "beside")] }, s, () => {});
    expect(shownIds(s)).toEqual(["b1", "b2", "b3", "f"]);
    s.setScreen(PHONE);
    const cmds = s.relayout();
    expect(cmds.length).toBeGreaterThan(0);
    expect(shownIds(s)).toHaveLength(2);
    expect(shownIds(s)).toContain("f");
    expect([...shownIds(s), ...dockedIds(s)].sort()).toEqual(["b1", "b2", "b3", "f"]);
  });

  it("and back to desktop: what was put away only for lack of room comes back", () => {
    const s = new StageState();
    s.setScreen(DESKTOP);
    runStageTool("screen.compose", { items: [item("f", "focus"), item("b1", "beside"), item("b2", "beside")] }, s, () => {});
    s.setScreen(PHONE);
    s.relayout();
    s.setScreen(DESKTOP);
    s.relayout();
    expect(shownIds(s)).toEqual(["b1", "b2", "f"]);
    expect(dockedIds(s)).toEqual([]);
  });

  it("what was put away for another reason stays a chip", () => {
    const s = new StageState();
    s.setScreen(DESKTOP);
    runStageTool("screen.compose", { items: [item("old", "focus")] }, s, () => {});
    runStageTool("screen.compose", { items: [item("new", "focus")], mode: "replace" }, s, () => {});
    s.relayout();
    expect(dockedIds(s)).toEqual(["old"]);
  });

  it("an object the owner moved is left alone", () => {
    const s = new StageState();
    s.setScreen(DESKTOP);
    runStageTool("screen.compose", { items: [item("f", "focus"), item("b", "beside")] }, s, () => {});
    const box = { x: 0.1, y: 0.2, w: 0.3, h: 0.3 };
    s.apply({ cmd: "place", id: "b", placement: box }, Date.now(), true);
    s.setScreen(PHONE);
    s.relayout();
    expect(s.snapshot().objects.find((o) => o.id === "b")?.placement).toEqual(box);
  });

  it("with nothing composed there is nothing to do", () => {
    const s = new StageState();
    s.setScreen(PHONE);
    expect(s.relayout()).toEqual([]);
  });
});

describe("review fixes: what a screen change must not do", () => {
  it("never deletes chips, however small the new screen", () => {
    const s = new StageState();
    s.setScreen(DESKTOP);
    runStageTool("screen.compose", { items: ["c1", "c2", "c3", "c4", "c5", "c6"].map((id) => ({ id, type: "card", props: { title: id, text: id }, role: "glance" })) }, s, () => {});
    runStageTool("screen.compose", { items: [item("f", "focus"), item("b1", "beside"), item("b2", "beside"), item("b3", "beside")], mode: "add" }, s, () => {});
    s.setScreen(PHONE);
    s.relayout();
    const ids = s.snapshot().objects.map((o) => o.id);
    for (const id of ["c1", "c2", "c3", "c4", "c5", "c6", "f"]) expect(ids).toContain(id);
  });

  it("leaves a plain stage.show object alone (no role: nothing moves it or puts it away)", () => {
    const s = new StageState();
    s.setScreen(DESKTOP);
    s.apply({ cmd: "show", object: { id: "x", type: "card", props: { text: "x" }, placement: "left", ttl: 600 } });
    const before = JSON.stringify(s.snapshot().objects);
    s.setScreen(PHONE);
    expect(s.relayout()).toEqual([]);
    s.setScreen(DESKTOP);
    expect(s.relayout()).toEqual([]);
    expect(JSON.stringify(s.snapshot().objects)).toBe(before);
  });

  it("keeps the time and the style of what it moves", () => {
    const s = new StageState();
    s.setScreen(DESKTOP);
    s.apply({ cmd: "show", object: { id: "b", type: "card", props: { text: "b" }, placement: "auto", role: "beside", ttl: 600, style: "glass" } });
    s.setScreen({ ...DESKTOP, width: 1366, height: 768 });
    s.relayout();
    expect(s.snapshot().objects.find((o) => o.id === "b")).toMatchObject({ ttl: 600, style: "glass" });
  });
});
