import { beforeEach, describe, expect, it } from "vitest";
import { readMuted, readQuiet, saveMuted, saveQuiet } from "./menuShared";

describe("the muted stage is remembered on this device", () => {
  beforeEach(() => localStorage.clear());

  it("is not muted until it is turned on", () => {
    expect(readMuted()).toBe(false);
  });

  it("is still muted after the page is reloaded, and unmuting is remembered too", () => {
    saveMuted(true);
    expect(readMuted()).toBe(true);
    saveMuted(false);
    expect(readMuted()).toBe(false);
  });
});

describe("keeping the voice off is remembered on this device", () => {
  beforeEach(() => localStorage.clear());

  it("speaks until it is turned off", () => {
    expect(readQuiet()).toBe(false);
  });

  it("stays off after a reload, and is its own choice, apart from the muted stage", () => {
    saveQuiet(true);
    expect(readQuiet()).toBe(true);
    expect(readMuted()).toBe(false);
    saveMuted(true);
    saveQuiet(false);
    expect(readQuiet()).toBe(false);
    expect(readMuted()).toBe(true);
  });
});