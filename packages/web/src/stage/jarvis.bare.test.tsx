import { readFileSync } from "node:fs";
import { join } from "node:path";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { initialState } from "../store";
import { Stage } from "./Stage";

const voice = { pressStart: vi.fn(), pressEnd: vi.fn(), blur: vi.fn() };
const objects = (type: "jarvis" | "card") => [{ id: "o1", type, props: type === "jarvis" ? { ui: { c: "JBadge", kids: ["x"] } } : { text: "x" }, placement: "left" as const }];
const css = readFileSync(join(process.cwd(), "src/styles.css"), "utf8");

describe("a Jarvis drawing on the stage", () => {
  it("is not put inside another card: the Jarvis card is the card", () => {
    const { container } = render(<Stage state={{ ...initialState, connection: "open", objects: objects("jarvis") }} send={() => {}} dispatch={() => {}} voice={voice} />);
    expect(container.querySelector('[data-object="o1"]')!.className).toContain("obj-bare");
  });

  it("leaves every other kind of object in its glass card", () => {
    const { container } = render(<Stage state={{ ...initialState, connection: "open", objects: objects("card") }} send={() => {}} dispatch={() => {}} voice={voice} />);
    expect(container.querySelector('[data-object="o1"]')!.className).not.toContain("obj-bare");
  });

  it("keeps what is in the card in the middle of it, so a tall box is not left empty at the bottom", () => {
    expect(css).toMatch(/\.obj-bare \.obj-jarvis > :not\(\.obj-title\) \{[^}]*justify-content: center/);
  });

  it("has no padding, background or border of its own, and gives the whole of its box to what is drawn", () => {
    expect(css).toMatch(/\.obj\.obj-bare \{[^}]*padding: 0/);
    expect(css).toMatch(/\.obj\.obj-bare \{[^}]*background: color-mix\(in srgb, #050b10 9\d%, transparent\)/); // dark enough that nothing behind shows through
    expect(css).toMatch(/\.obj\.obj-bare \{[^}]*border: 0/);
    expect(css).toMatch(/\.obj-bare \.obj-jarvis \{[^}]*height: 100%/);
    expect(css).toMatch(/\.obj-bare \.obj-jarvis > :not\(\.obj-title\) \{[^}]*height: 100%/); // the Jarvis card is as big as the box it was given
  });
});