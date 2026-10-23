import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
const rule = (sel: string): string => {
  const m = new RegExp(`${sel.replace(/[.[\]*]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
  return m?.[1] ?? "";
};

describe("the YouTube player's size", () => {
  it("keeps the shape of a video (16:9) whatever room the card is given, instead of stretching wide and short", () => {
    const r = rule(".media-fill .obj-youtube".replace("media-fill", "obj-media-fill"));
    expect(r).toMatch(/aspect-ratio:\s*16\s*\/\s*9/);
    expect(r).toMatch(/height:\s*auto/);
    expect(r).not.toMatch(/height:\s*100%/);
  });

  it("is not wider than a 16:9 picture that fits the screen's height", () => {
    expect(rule(".obj-media-fill .obj-youtube")).toMatch(/width:\s*min\(100%,\s*calc\(\d+vh \* 16 \/ 9\)\)/);
  });
});