import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";


afterEach(cleanup);

describe("how the Jarvis drawings use the room they are given", () => {
  const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");
  it("makes the parts of a column or a grid take its whole width, and what is in a card take the card's whole width", () => {
    expect(css).toMatch(/\.jv-col > \*[^{]*\{[^}]*width: 100%/);
    expect(css).toMatch(/\.jv-grid > \*[^{]*\{[^}]*width: 100%/);
    expect(css).toMatch(/\.obj-jarvis \[class\*="j-card"\] > \*[^{]*\{[^}]*width: 100%/);
  });
  it("shares a row evenly, and lets its parts shrink", () => {
    expect(css).toMatch(/\.jv-row > \* \{[^}]*flex: 1 1 0[^}]*min-width: 0/);
  });
  it("lets a chart or a table in any of them fill the width", () => {
    expect(css).toMatch(/\.obj-jarvis (svg|table|\.recharts-responsive-container)[^{]*\{[^}]*max-width: 100%/);
  });
});

