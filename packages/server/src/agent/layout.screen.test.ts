import { describe, expect, it } from "vitest";
import { screenGuide } from "./guide";
import { LAYOUT_GUIDE } from "./layout";

describe("using the whole screen, not one card", () => {
  it("tells the assistant that a big screen is for many objects in many places, one thing each", () => {
    expect(LAYOUT_GUIDE).toMatch(/whole screen/i);
    expect(LAYOUT_GUIDE).toMatch(/its own (object|place)/i);
    expect(LAYOUT_GUIDE).toMatch(/corners/i);
    expect(LAYOUT_GUIDE).toMatch(/Do not pack/i);
    expect(LAYOUT_GUIDE).not.toMatch(/Fewer, richer objects/);
    expect(LAYOUT_GUIDE).not.toMatch(/Do not make one card per fact/);
  });

  it("says when an old object may be changed and when the screen is cleared", () => {
    expect(LAYOUT_GUIDE).toMatch(/same thing refreshed/i);
    expect(LAYOUT_GUIDE).toMatch(/different topic is a new object/i);
    expect(LAYOUT_GUIDE).toMatch(/stage\.clear/);
    expect(LAYOUT_GUIDE).toMatch(/whenever you need the room/i);
  });

  it("says the same in the manual's layout section, and that a Jarvis dashboard is several objects", () => {
    const layout = screenGuide("layout");
    expect(layout).toMatch(/whole screen/i);
    expect(layout).not.toMatch(/Fewer, richer objects/);
    expect(layout).toMatch(/same thing refreshed/i);
    expect(screenGuide("widgets")).toMatch(/several jarvis objects|one jarvis object for each part/i);
  });

  it("keeps the phone and tablet limits", () => {
    expect(screenGuide("layout")).toMatch(/Phone: everything stacks in one column/);
    expect(LAYOUT_GUIDE).toMatch(/on a phone everything stacks/i);
  });
});