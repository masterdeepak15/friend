import { describe, expect, it } from "vitest";
import { screenGuide } from "./agent/guide";
import { StageState, propsError, runStageTool } from "./stage";

describe("the assistant drawing with the Jarvis components, as object types", () => {
  const show = (stage: StageState, type: string, props: Record<string, unknown>, id = "o") => runStageTool("stage.show", { object: { id, type, props, placement: "center" } }, stage, () => {});

  it("shows an object whose type is a Jarvis component, with that component's props", () => {
    const stage = new StageState();
    expect(propsError("JStatCard", { title: "CPU", value: "42%" }, true)).toBeNull();
    expect(show(stage, "JStatCard", { title: "CPU", value: "42%", barValue: 42 }).ok).toBe(true);
    expect(show(stage, "JCard", { kids: [{ c: "JBadge", kids: ["x"] }], slots: { header: ["HEAD"] } }, "card2").ok).toBe(true);
  });

  it("refuses a prop the component does not have, a handler, or a part that is not allowed, with a sentence she can act on", () => {
    const stage = new StageState();
    const bad = show(stage, "JBadge", { onClick: "x" });
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).toMatch(/onClick/);
    expect(propsError("JStatCard", { nonsense: 1 }, true)).toMatch(/nonsense/);
    expect(show(stage, "JCard", { kids: [{ c: "JDesktop" }] }, "d").ok).toBe(false);
  });

  it("is no longer a type of its own: jarvis is not an object type", () => {
    const stage = new StageState();
    expect(show(stage, "jarvis", { ui: { c: "JBadge", kids: ["x"] } }).ok).toBe(false);
  });

  it("checks an update, and a part inside a group", () => {
    expect(propsError("JStatCard", { nonsense: 1 }, false)).toMatch(/nonsense/);
    expect(propsError("group", { items: [{ type: "JStatCard", props: { nonsense: 1 } }] }, true)).toMatch(/nonsense/);
    expect(propsError("group", { items: [{ type: "JStatCard", props: { title: "a", value: "1" } }] }, true)).toBeNull();
  });

  it("is in the manual as ordinary widgets with every component, its props and its size, and says to use them first", () => {
    const widgets = screenGuide("widgets");
    expect(widgets).toMatch(/JStatCard/);
    expect(widgets).toMatch(/JNodeGraph/);
    expect(widgets).toMatch(/object types/i);
    expect(widgets).toMatch(/use them first|first choice/i);
    expect(widgets).not.toMatch(/jarvis \{title\?, ui\}/); // no separate jarvis object
  });
});