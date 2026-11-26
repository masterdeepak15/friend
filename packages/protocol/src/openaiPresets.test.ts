import { describe, expect, it } from "vitest";
import { OPENAI_PRESETS, presetFor } from "./index";

describe("OpenAI-compatible presets", () => {
  it("lists OmniRoute, Grok, Gemini, OpenRouter, NVIDIA NIM, Z.ai and OpenCode Zen with https addresses (OmniRoute is on this PC)", () => {
    expect(OPENAI_PRESETS.map((p) => p.id)).toEqual(["omniroute", "xai", "gemini", "openrouter", "nvidia", "zai", "opencode-zen"]);
    for (const p of OPENAI_PRESETS) {
      expect(p.url.startsWith(p.id === "omniroute" ? "http://localhost:" : "https://")).toBe(true);
      expect(p.url.endsWith("/")).toBe(false);
      expect(p.hint.length).toBeGreaterThan(10);
    }
  });

  it("finds the preset of an address, ignoring a trailing slash, and says null for anything else", () => {
    expect(presetFor("https://api.x.ai/v1/")?.id).toBe("xai");
    expect(presetFor("http://localhost:20128/v1")?.id).toBe("omniroute");
    expect(presetFor("https://example.com/v1")).toBeNull();
  });
});
