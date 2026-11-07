import { describe, expect, it } from "vitest";
import { diffSettings, needsPin, type SettingsView } from "./settingsApi";

const base = { eye: { on: true, autoOffMinutes: 120 } } as SettingsView;
const diff = (eye: { on: boolean; autoOffMinutes: number }) => diffSettings(base, { ...base, eye }, "");

describe("what the settings screen sends for the eye", () => {
  it("closing the eye sends only that, so no PIN is needed", () => {
    const patch = diff({ on: false, autoOffMinutes: 120 });
    expect(patch).toEqual({ eye: { on: false } });
    expect(needsPin(patch)).toBe(false);
  });

  it("opening the eye sends only that, and needs the PIN", () => {
    const closed = { eye: { on: false, autoOffMinutes: 120 } } as SettingsView;
    const patch = diffSettings(closed, { ...closed, eye: { on: true, autoOffMinutes: 120 } }, "");
    expect(patch).toEqual({ eye: { on: true } });
    expect(needsPin(patch)).toBe(true);
  });

  it("changing the minutes sends only the minutes, and needs the PIN", () => {
    const patch = diff({ on: true, autoOffMinutes: 30 });
    expect(patch).toEqual({ eye: { autoOffMinutes: 30 } });
    expect(needsPin(patch)).toBe(true);
  });

  it("closing and changing the minutes together needs the PIN", () => {
    const patch = diff({ on: false, autoOffMinutes: 30 });
    expect(patch).toEqual({ eye: { on: false, autoOffMinutes: 30 } });
    expect(needsPin(patch)).toBe(true);
  });

  it("sends nothing when the eye did not change", () => {
    expect(diff({ on: true, autoOffMinutes: 120 })).toEqual({});
  });
});
