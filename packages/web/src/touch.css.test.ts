import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(join(__dirname, "styles.css"), "utf8");

/** The text between the braces of the first rule that starts a line with this selector. */
const rule = (selector: string): string => {
  const at = css.split("\n").findIndex((l) => l.startsWith(`${selector} {`));
  if (at < 0) return "";
  const rest = css.split("\n").slice(at).join("\n");
  return rest.slice(rest.indexOf("{") + 1, rest.indexOf("}"));
};

describe("a phone can tap what is under the objects layer", () => {
  it("the full-screen objects stack lets the pointer through; only the objects in it take it", () => {
    expect(rule(".objects-stack")).toMatch(/pointer-events:\s*none/);
    expect(rule(".objects-stack > .obj")).toMatch(/pointer-events:\s*auto/);
  });

  it("the corner long-press area is off on touch screens and narrow windows, where it covered the first launcher chip", () => {
    expect(css).toContain("@media (pointer: coarse), (max-width: 720px) { .owner-hotspot { display: none; } }");
  });
});
