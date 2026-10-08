import { describe, expect, it } from "vitest";
import { promisesAction } from "./promise";

describe("promisesAction", () => {
  it.each([
    "Got it, Deepak. Let's go ahead and fetch the system information for your computer and display it on the screen.\n\nI'll run the system information command now.",
    "I'll fetch the current weather in Pune and then provide you with your computer stats.",
    "Let me check that for you.",
    "I will get the weather now.",
    "I'm going to show the numbers on the screen.",
    "Sure! Let's look up the forecast.",
  ])("recognizes a promise to act: %s", (t) => expect(promisesAction(t)).toBe(true));

  it.each([
    "Hello! How can I help you today?",
    "I'll be happy to help.",
    "Done. The weather is on the screen.",
    "I can fetch the weather if you like.",
    "Would you like me to fetch the weather in Pune?",
    "Let me know if you want anything else.",
    "The system information is shown on the screen. Anything else?",
    "",
  ])("leaves ordinary answers alone: %s", (t) => expect(promisesAction(t)).toBe(false));

  it("looks at how the reply ends, not at what it said at the start of a long answer", () => {
    const long = "I'll fetch it first. " + "Here is a long explanation of the result. ".repeat(20) + "That is everything.";
    expect(promisesAction(long)).toBe(false);
  });
});
