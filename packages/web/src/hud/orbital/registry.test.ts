import { HUD_WIDGET_IDS, type HudWidgetId } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { WIDGETS, visibleWidgets } from "./registry";

const ids = (...args: Parameters<typeof visibleWidgets>): HudWidgetId[] => visibleWidgets(...args).map((w) => w.id);

describe("the widget registry", () => {
  it("has exactly one entry for every widget id, in a stable order", () => {
    expect(WIDGETS.map((w) => w.id)).toEqual([...HUD_WIDGET_IDS]);
  });

  it("puts each widget where the approved mockup has it, on the canvas", () => {
    const at = Object.fromEntries(WIDGETS.map((w) => [w.id, [w.anchor, w.box.x, w.box.y, w.box.w, w.box.h]]));
    expect(at).toMatchObject({
      system: ["left", 40, 70, 300, 220],
      voice: ["left", 40, 310, 300, 150],
      network: ["left", 40, 480, 300, 110],
      feed: ["left", 40, 650, 430, 210],
      radar: ["right", 1310, 60, 250, 270],
      tickets: ["right", 1300, 320, 270, 160],
      budget: ["right", 1300, 480, 270, 110],
      approval: ["right", 1180, 650, 380, 210],
      usage: ["centre", 700, 215, 200, 30],
    });
  });
});
describe("which widgets show at each density", () => {
  it("calm shows only the usage ring", () => {
    expect(ids("calm", {}, "orbit", false)).toEqual(["usage"]);
  });

  it("standard shows system, voice, feed, approval and usage", () => {
    expect(ids("standard", {}, "orbit", false)).toEqual(["system", "voice", "feed", "approval", "usage"]);
  });

  it("full shows everything", () => {
    expect(ids("full", {}, "orbit", false)).toEqual([...HUD_WIDGET_IDS]);
  });

  it("a switched-off widget stays off at every density, and a switched-on one shows even at calm", () => {
    expect(ids("full", { radar: false }, "orbit", false)).not.toContain("radar");
    expect(ids("calm", { radar: true }, "orbit", false)).toEqual(["radar", "usage"]);
    expect(ids("standard", { usage: false }, "orbit", false)).not.toContain("usage");
  });

  it("an approval that is waiting always shows, whatever the density or the switch", () => {
    expect(ids("calm", { approval: false }, "orbit", true)).toEqual(["approval", "usage"]);
    expect(ids("full", { approval: false }, "compact", true)).toContain("approval");
  });

  it("lists the same widgets in the compact layout", () => {
    expect(ids("standard", {}, "compact", false)).toEqual(ids("standard", {}, "orbit", false));
  });

  it("ignores switches for widgets it does not know", () => {
    expect(ids("calm", { bogus: true } as never, "orbit", false)).toEqual(["usage"]);
  });
});
