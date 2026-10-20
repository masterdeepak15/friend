import { describe, expect, it } from "vitest";
import { HUD_DENSITIES, HUD_LAYOUTS, HUD_WIDGET_IDS, HudView, ServerMsg } from "./index";

const base = { terminalLabel: "TERMINAL", clock: { hour12: true, seconds: false, locale: "" }, launcher: [], animations: "full" as const };

describe("the orbital screen settings in the protocol", () => {
  it("names the layouts, densities and widgets", () => {
    expect(HUD_LAYOUTS).toEqual(["classic", "orbital"]);
    expect(HUD_DENSITIES).toEqual(["calm", "standard", "full"]);
    expect([...HUD_WIDGET_IDS]).toEqual(["system", "voice", "network", "feed", "radar", "tickets", "budget", "approval", "usage"]);
  });

  it("accepts a view with a layout, a density and widget switches", () => {
    const v = HudView.parse({ ...base, layout: "orbital", density: "calm", widgets: { radar: false } });
    expect(v).toMatchObject({ layout: "orbital", density: "calm", widgets: { radar: false } });
  });

  it("refuses a layout or a density it does not know", () => {
    expect(HudView.safeParse({ ...base, layout: "cube", density: "calm", widgets: {} }).success).toBe(false);
    expect(HudView.safeParse({ ...base, layout: "orbital", density: "packed", widgets: {} }).success).toBe(false);
  });

  it("carries the stats feed", () => {
    const ok = ServerMsg.safeParse({ type: "hud.stats", cpu: 38, ramUsed: 8e9, ramTotal: 16e9, netDown: 0, netUp: 0 });
    expect(ok.success).toBe(true);
    expect(ServerMsg.safeParse({ type: "hud.stats", cpu: 101, ramUsed: 1, ramTotal: 2, netDown: 0, netUp: 0 }).success).toBe(false);
  });
});
