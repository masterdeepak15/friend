import { describe, expect, it } from "vitest";
import { screenGuide } from "./guide";
import { LAYOUT_GUIDE } from "./layout";

describe("a clear screen, not a crowded one", () => {
  it("tells the assistant to say what each thing is for and to keep the screen light", () => {
    expect(LAYOUT_GUIDE).toMatch(/screen\.compose/);
    expect(LAYOUT_GUIDE).toMatch(/you never give coordinates/i);
    expect(LAYOUT_GUIDE).toMatch(/Less is clearer/);
    expect(LAYOUT_GUIDE).toMatch(/Do not fill the screen/);
  });

  it("says when an old object may be changed and when the screen is replaced", () => {
    expect(LAYOUT_GUIDE).toMatch(/same thing refreshed/i);
    expect(LAYOUT_GUIDE).toMatch(/different topic is a new object/i);
    expect(LAYOUT_GUIDE).toMatch(/stage\.clear/);
    expect(LAYOUT_GUIDE).toMatch(/mode replace/);
  });

  it("says the same in the manual's layout section, and that a Jarvis dashboard is several objects", () => {
    const layout = screenGuide("layout");
    expect(layout).toMatch(/screen\.compose/);
    expect(layout).toMatch(/do not fill the screen/i);
    expect(layout).toMatch(/same thing refreshed/i);
    expect(screenGuide("widgets")).toMatch(/for a dashboard make several objects, each in its own place/i);
  });

  it("treats a Jarvis card as an instrument of modest size, not a wide banner", () => {
    expect(screenGuide("widgets")).toMatch(/instrument/i);
    expect(screenGuide("widgets")).toMatch(/the box its content needs/);
    expect(screenGuide("widgets")).toMatch(/JStatCard[^\n]*about \d+x\d+ px/);
    expect(screenGuide("widgets")).toMatch(/fits the box to the content/);
    expect(LAYOUT_GUIDE).toMatch(/instrument/i);
    expect(LAYOUT_GUIDE).toMatch(/not a wide banner/i);
    expect(LAYOUT_GUIDE).toMatch(/size in pixels/i);
  });

  it("keeps the phone and tablet limits", () => {
    expect(screenGuide("layout")).toMatch(/Phone: everything stacks in one column/);
    expect(LAYOUT_GUIDE).toMatch(/on a phone everything stacks/i);
  });
});