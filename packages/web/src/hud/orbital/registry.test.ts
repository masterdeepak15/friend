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

  it("standard and full show the budget ring and the usage line, and none of the live instruments: the home screen is clean until the assistant brings one up", () => {
    expect(ids("standard", {}, "orbit", false)).toEqual(["budget", "usage"]);
    expect(ids("full", {}, "orbit", false)).toEqual(["budget", "usage"]);
  });

  it("a live instrument shows when the assistant brought it up, or when the owner switched it on, and the owner's off wins", () => {
    expect(ids("standard", {}, "orbit", false, ["voice", "system"])).toEqual(["system", "voice", "budget", "usage"]);
    expect(ids("standard", { radar: true }, "orbit", false)).toEqual(["radar", "budget", "usage"]);
    expect(ids("standard", { system: false }, "orbit", false, ["system"])).toEqual(["budget", "usage"]);
    expect(ids("calm", {}, "orbit", false, ["tickets"])).toEqual(["tickets", "usage"]);
  });

  it("the approvals frame is there only while something waits, unless the owner switched it on", () => {
    expect(ids("standard", {}, "orbit", false)).not.toContain("approval");
    expect(ids("standard", {}, "orbit", true)).toContain("approval");
    expect(ids("calm", { approval: true }, "orbit", false)).toEqual(["approval", "usage"]);
  });

  it("the sample preview shows everything the owner has not switched off", () => {
    expect(ids("calm", {}, "orbit", false, [], true)).toEqual([...HUD_WIDGET_IDS]);
    expect(ids("calm", { radar: false }, "orbit", false, [], true)).not.toContain("radar");
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
    expect(ids("standard", {}, "compact", false, ["system"])).toEqual(ids("standard", {}, "orbit", false, ["system"]));
  });

  it("ignores switches for widgets it does not know", () => {
    expect(ids("calm", { bogus: true } as never, "orbit", false)).toEqual(["usage"]);
  });
});
