import { TOOL_DEFS } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { screenGuide } from "./guide";
import { buildSystemPrompt } from "./prompt";

const prompt = buildSystemPrompt("Maya", "empty", "owner");

describe("the instructions all lead with screen.compose", () => {
  it("the system prompt tells the assistant to use screen.compose, not stage.show with a place", () => {
    expect(prompt).toMatch(/screen\.compose/);
    expect(prompt).not.toMatch(/put it on the screen with stage\.show/);
    expect(prompt).not.toMatch(/Use placement "auto" for several objects/);
  });
  it("it says what to do first: read the screen-design skill, then compose, then check", () => {
    expect(prompt).toMatch(/screen-design/);
    expect(prompt).toMatch(/stage\.check/);
  });
  it("stage.show is described as for one small thing, with screen.compose first", () => {
    const d = TOOL_DEFS.find((t) => t.name === "stage.show")!.description;
    expect(d).toMatch(/screen\.compose/);
  });
  it("the manual does not promise three places beside on every desktop", () => {
    expect(screenGuide("layout")).not.toMatch(/Desktop: a focus and three beside/);
  });
  it("weather.get and system.info results say the screen was laid out for them by screen.compose rules, not 'auto' cards", () => {
    expect(prompt).not.toMatch(/draw their own pictures on the screen/);
  });
});
