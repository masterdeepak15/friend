import { HUD_WIDGET_IDS, type HudWidgetId } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { WIDGETS, visibleWidgets } from "./registry";

const ids = (...args: Parameters<typeof visibleWidgets>): HudWidgetId[] => visibleWidgets(...args).map((w) => w.id);

describe("the widget registry", () => {
  it("has exactly one entry for every widget id, in a stable order", () => {
    expect(WIDGETS.map((w) => w.id)).toEqual([...HUD_WIDGET_IDS]);
  });

  it("puts each widget where the approved mockup has it", () => {
    const zone = Object.fromEntries(WIDGETS.map((w) => [w.id, w.zone]));
    expect(zone).toMatchObject({ system: "left-top", voice: "left-mid", network: "left-mid", feed: "left-bottom", radar: "right-top", tickets: "right-mid", budget: "right-mid", approval: "right-bottom", usage: "centre" });
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
