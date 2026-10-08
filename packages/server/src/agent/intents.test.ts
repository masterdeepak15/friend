import { describe, expect, it } from "vitest";
import { detectIntents } from "./intents";

const names = (text: string) => detectIntents(text).map((c) => c.name);

describe("detectIntents: weather", () => {
  it.each([
    ["What is the weather in Pune?", "Pune"],
    ["show me the weather in Pune today", "Pune"],
    ["weather in new delhi", "new delhi"],
    ["How's the weather in San Francisco right now?", "San Francisco"],
    ["Fetch the weather for Mumbai and show it", "Mumbai"],
    ["will it rain in Bengaluru tomorrow", "Bengaluru"],
    ["Yes, fetch the only weather and after that also get the weather in Pune.", "Pune"],
  ])("asks for the weather: %s", (text, city) => {
    expect(detectIntents(text)).toEqual([{ name: "weather.get", args: { city } }]);
  });

  it.each([
    "What is the weather like?", // no place named: the model should ask which city
    "weather",
    "is it good weather for a walk",
    "How was the weather in my notes",
    "tell me the weather in the city",
    "What is the weather here?",
    "I like rainy weather",
    "my CPU temperature in the case is high",
  ])("does not guess a city: %s", (text) => {
    expect(names(text)).not.toContain("weather.get");
  });
});

describe("detectIntents: computer stats", () => {
  it.each([
    "show me my computer stats",
    "How is my computer doing?",
    "give me the system status",
    "what's my CPU usage",
    "how much disk space is free",
    "check my pc health",
    "memory usage please",
    "get the system information for my laptop",
  ])("asks about the computer: %s", (text) => {
    expect(detectIntents(text)).toEqual([{ name: "system.info", args: {} }]);
  });

  it.each([
    "tell me about the solar system",
    "I want to improve my memory",
    "What is a computer?",
    "my favourite disk jockey",
    "the immune system status of the patient",
    "hello there",
    "",
  ])("leaves other talk alone: %s", (text) => {
    expect(names(text)).not.toContain("system.info");
  });
});

describe("detectIntents: both at once", () => {
  it("handles weather and computer stats in one request, in the order asked", () => {
    expect(detectIntents("Show me the weather in Pune and also my computer stats on the screen.")).toEqual([
      { name: "weather.get", args: { city: "Pune" } },
      { name: "system.info", args: {} },
    ]);
  });

  it("never produces more than two calls, and never anything but these read-only tools", () => {
    const many = detectIntents("weather in Pune, weather in Delhi, my computer stats, my cpu status, weather in Goa");
    expect(many.length).toBeLessThanOrEqual(2);
    expect(many.every((c) => c.name === "weather.get" || c.name === "system.info")).toBe(true);
  });

  it("keeps a city name tidy and short", () => {
    const [c] = detectIntents("weather in   Pune   !!!  ");
    expect(c).toEqual({ name: "weather.get", args: { city: "Pune" } });
    expect(detectIntents(`weather in ${"x".repeat(200)}`)).toEqual([]);
  });
});
