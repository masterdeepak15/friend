import { describe, expect, it } from "vitest";
import { screenGuide } from "./agent/guide";
import { StageState, propsError, runStageTool } from "./stage";

describe("the assistant drawing with the Jarvis components", () => {
  const ok = { ui: { c: "Column", kids: [{ c: "JStatCard", p: { title: "CPU", value: "42%" } }] } };

  it("is drawn when the tree is valid", () => {
    expect(propsError("jarvis", ok, true)).toBeNull();
    const stage = new StageState();
    const r = runStageTool("stage.show", { object: { id: "j", type: "jarvis", props: ok, placement: "center" } }, stage, () => {});
    expect(r.ok).toBe(true);
  });

  it("is refused with a sentence the assistant can act on, so nothing broken or unsafe reaches the screen", () => {
    const stage = new StageState();
    const bad = runStageTool("stage.show", { object: { id: "j", type: "jarvis", props: { ui: { c: "JBadge", p: { onClick: "x" } } }, placement: "center" } }, stage, () => {});
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).toMatch(/onClick/);
    expect(propsError("jarvis", {}, true)).toMatch(/ui/);
    expect(runStageTool("stage.show", { object: { id: "j", type: "jarvis", props: { ui: { c: "JDesktop" } }, placement: "center" } }, stage, () => {}).ok).toBe(false);
  });

  it("checks an update too, and inside a group", () => {
    expect(propsError("jarvis", { ui: { c: "Nope" } }, false)).toMatch(/Nope/);
    expect(propsError("group", { items: [{ type: "jarvis", props: { ui: { c: "Nope" } } }] }, true)).toMatch(/Nope/);
  });

  it("is in the manual with every component and its props", () => {
    const widgets = screenGuide("widgets");
    expect(widgets).toMatch(/jarvis \{/);
    expect(widgets).toMatch(/JStatCard/);
    expect(widgets).toMatch(/JNodeGraph/);
    expect(widgets).toMatch(/never code/i);
  });
});