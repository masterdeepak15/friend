import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, sanitizeHud } from "./config";
import { applySettings, refuseForAgent, settingsView } from "./settings";

const fresh = () => loadConfig(mkdtempSync(join(tmpdir(), "friend-hudlayout-")));

describe("the orbital screen settings", () => {
  it("default to the classic screen, standard density and no widget overrides", () => {
    const h = sanitizeHud({});
    expect(h).toMatchObject({ layout: "classic", density: "standard", widgets: {} });
  });

  it("keep only known values when read back from the saved file", () => {
    const h = sanitizeHud({ layout: "orbital", density: "full", widgets: { radar: false, bogus: true, feed: "yes", usage: true } });
    expect(h).toMatchObject({ layout: "orbital", density: "full", widgets: { radar: false, usage: true } });
    expect(Object.keys(h.widgets).sort()).toEqual(["radar", "usage"]);
    expect(sanitizeHud({ layout: "nope", density: "nope" })).toMatchObject({ layout: "classic", density: "standard" });
  });

  it("are saved by applySettings, merging widget switches instead of replacing them", () => {
    const config = fresh();
    applySettings(config, { hud: { layout: "orbital", density: "calm" } });
    expect(config.hud).toMatchObject({ layout: "orbital", density: "calm" });
    applySettings(config, { hud: { widgets: { radar: false } } });
    applySettings(config, { hud: { widgets: { feed: false } } });
    expect(config.hud.widgets).toEqual({ radar: false, feed: false });
    expect(settingsView(config).hud.widgets).toEqual({ radar: false, feed: false });
  });

  it("refuse a layout, a density or a widget that does not exist", () => {
    const config = fresh();
    expect(() => applySettings(config, { hud: { layout: "cube" } as never })).toThrow();
    expect(() => applySettings(config, { hud: { density: "packed" } as never })).toThrow();
    expect(() => applySettings(config, { hud: { widgets: { bogus: true } } as never })).toThrow();
    expect(config.hud.layout).toBe("classic");
  });

  it("cannot be changed by the assistant", () => {
    expect(() => refuseForAgent({ hud: { layout: "orbital" } } as never)).toThrow(/only be changed by the owner/);
  });
});
