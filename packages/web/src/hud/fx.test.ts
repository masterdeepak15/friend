import { describe, expect, it } from "vitest";
import { scrambleFrame, scrambleSteps } from "./fx";

const seeded = () => {
  let n = 7;
  return () => {
    n = (n * 9301 + 49297) % 233280;
    return n / 233280;
  };
};

describe("the title scramble", () => {
  it("starts as noise of the right length, keeps spaces, and ends as the real text", () => {
    const rand = seeded();
    const first = scrambleFrame("So What", 0, rand);
    expect(first).toHaveLength(7);
    expect(first[2]).toBe(" ");
    expect(scrambleFrame("So What", 1, rand)).toBe("So What");
  });

  it("settles from the left: the letters already settled are the real ones", () => {
    const rand = seeded();
    const mid = scrambleFrame("Blue in Green", 0.5, rand);
    expect(mid.slice(0, 6)).toBe("Blue i");
    expect(mid).toHaveLength(13);
  });

  it("copes with empty text, and with letters outside the basic alphabet", () => {
    expect(scrambleFrame("", 0.3)).toBe("");
    const out = scrambleFrame("मेरा गाना", 0.4, seeded());
    expect(out).toHaveLength([..."मेरा गाना"].length);
  });

  it("is a few steps long, never zero, and fewer for long text so it stays quick", () => {
    expect(scrambleSteps("Hi")).toBeGreaterThanOrEqual(6);
    expect(scrambleSteps("x".repeat(500))).toBeLessThanOrEqual(24);
    expect(scrambleSteps("")).toBe(0);
  });
});
