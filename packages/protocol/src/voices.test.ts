import { describe, expect, it } from "vitest";
import { ORIGINAL_VOICE, VOICE_CHOICES, isCatalogVoice, resolveVoice, voiceLabel } from "./voices";

describe("the voice list", () => {
  it("offers several female and several male voices", () => {
    expect(VOICE_CHOICES.filter((v) => v.gender === "female").length).toBeGreaterThanOrEqual(5);
    expect(VOICE_CHOICES.filter((v) => v.gender === "male").length).toBeGreaterThanOrEqual(5);
  });
  it("lists every voice once, with a Piper name, a person's name and an accent", () => {
    expect(new Set(VOICE_CHOICES.map((v) => v.id)).size).toBe(VOICE_CHOICES.length);
    expect(new Set(VOICE_CHOICES.map((v) => v.name)).size).toBe(VOICE_CHOICES.length);
    for (const v of VOICE_CHOICES) {
      expect(v.id, v.name).toMatch(/^[a-z]{2}_[A-Z]{2}-[A-Za-z0-9_]+-(x_low|low|medium|high)$/);
      expect(v.name.length).toBeGreaterThan(1);
      expect(v.accent.length).toBeGreaterThan(2);
      expect(["female", "male"]).toContain(v.gender);
    }
  });
  it("keeps the original voice, which is not in the numbered list", () => {
    expect(ORIGINAL_VOICE.id).toBe("en_US-lessac-medium");
    expect(VOICE_CHOICES.some((v) => v.id === ORIGINAL_VOICE.id)).toBe(false);
    expect(isCatalogVoice(ORIGINAL_VOICE.id)).toBe(true);
    expect(isCatalogVoice("en_US-amy-medium")).toBe(true);
    expect(isCatalogVoice("xx_XX-nothing-medium")).toBe(false);
  });
  it("labels a voice in words", () => {
    expect(voiceLabel("en_US-amy-medium")).toBe("Amy (female, American)");
    expect(voiceLabel("en_US-lessac-medium")).toMatch(/Lessac.*original/);
    expect(voiceLabel("de_DE-thorsten-medium")).toBe("de_DE-thorsten-medium");
  });
});

describe("resolveVoice", () => {
  it("takes a number from the list", () => {
    expect(resolveVoice("1")).toMatchObject({ id: VOICE_CHOICES[0]!.id, listed: true });
    expect(resolveVoice(String(VOICE_CHOICES.length))).toMatchObject({ id: VOICE_CHOICES.at(-1)!.id });
    expect(resolveVoice("0")).toBeNull();
    expect(resolveVoice(String(VOICE_CHOICES.length + 1))).toBeNull();
  });
  it("takes female or male and gives the first of that kind", () => {
    expect(resolveVoice("female")).toMatchObject({ id: "en_US-amy-medium" });
    expect(resolveVoice(" Female ")).toMatchObject({ id: "en_US-amy-medium" });
    expect(resolveVoice("F")).toMatchObject({ id: "en_US-amy-medium" });
    expect(resolveVoice("male")).toMatchObject({ id: "en_US-ryan-medium" });
    expect(resolveVoice("M")).toMatchObject({ id: "en_US-ryan-medium" });
    expect(VOICE_CHOICES.find((v) => v.id === resolveVoice("female")!.id)!.gender).toBe("female");
    expect(VOICE_CHOICES.find((v) => v.id === resolveVoice("male")!.id)!.gender).toBe("male");
  });
  it("takes a name, in any case, and the original voice", () => {
    expect(resolveVoice("jenny")).toMatchObject({ id: "en_GB-jenny_dioco-medium" });
    expect(resolveVoice("ALAN")).toMatchObject({ id: "en_GB-alan-medium" });
    expect(resolveVoice("lessac")).toMatchObject({ id: "en_US-lessac-medium", listed: true });
    expect(resolveVoice("en_us-amy-medium")).toMatchObject({ id: "en_US-amy-medium" });
  });
  it("takes a full Piper name for a voice that is not in the list", () => {
    expect(resolveVoice("hi_IN-pratham-medium")).toEqual({ id: "hi_IN-pratham-medium", label: "hi_IN-pratham-medium", listed: false });
  });
  it("refuses anything else, including things that could be part of a path", () => {
    for (const bad of ["", "   ", "robot", "../../etc/passwd", "en_US-amy-medium/../x", "en_US-x-medium; rm", "a".repeat(200), "en_US-name-huge"]) expect(resolveVoice(bad), bad).toBeNull();
  });
});
