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

describe("the approval card with a long command", () => {
  const orbital = readFileSync(join(__dirname, "hud", "orbital", "orbital.css"), "utf8");
  it("scrolls the text on its own, keeps the buttons in view, and does not pulse", () => {
    expect(orbital).toMatch(/\.ob-approval \{ height: 100%; overflow: hidden;/);
    expect(orbital).toMatch(/\.ob-approval \.ob-summary \{[^}]*max-height: none; overflow-y: auto;/);
    expect(orbital).toContain('.ob-frame[data-tone="orange"].ob-modal { animation: none; opacity: 1; }');
    expect(orbital).toContain(".ob-modal::before { background: var(--ob-dark); }");
  });
});
