import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Jarvis } from "./jarvis";

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

describe("a screen drawn by the assistant with the Jarvis components", () => {
  it("draws a tree of components with their props and text", async () => {
    render(
      <Jarvis
        props={{
          title: "Overview",
          ui: { c: "Column", p: { gap: 6 }, kids: [{ c: "JStatCard", p: { title: "CPU LOAD", value: "42%" } }, { c: "JBadge", p: { color: "green" }, kids: ["ALL GOOD"] }] },
        }}
      />,
    );
    expect(await screen.findByText("CPU LOAD")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
    expect(screen.getByText("ALL GOOD")).toBeTruthy();
    expect(screen.getByText("Overview")).toBeTruthy();
  });

  it("draws a card with a header and a footer, and tabs that switch", async () => {
    render(
      <Jarvis
        props={{
          ui: {
            c: "Column",
            kids: [
              { c: "JCard", slots: { header: ["HEAD TEXT"], footer: [{ c: "JBadge", kids: ["FOOT"] }] }, kids: ["BODY TEXT"] },
              { c: "JTabs", kids: [{ c: "JTab", p: { tabKey: "a", label: "FIRST" }, kids: ["PANEL A"] }, { c: "JTab", p: { tabKey: "b", label: "SECOND" }, kids: ["PANEL B"] }] },
            ],
          },
        }}
      />,
    );
    expect(await screen.findByText("HEAD TEXT")).toBeTruthy();
    expect(screen.getByText("FOOT")).toBeTruthy();
    expect(screen.getByText("BODY TEXT")).toBeTruthy();
    expect(screen.getByText("PANEL A")).toBeTruthy();
    fireEvent.click(screen.getByText("SECOND"));
    expect(await screen.findByText("PANEL B")).toBeTruthy();
  });

  it("draws charts, indicators, a form and an accordion from the wider catalog", async () => {
    const { container } = render(
      <Jarvis
        props={{
          ui: {
            c: "Grid",
            p: { columns: 2 },
            kids: [
              { c: "JDonutChart", p: { data: [{ label: "A", value: 3 }, { label: "B", value: 5 }], centerValue: "8", centerLabel: "TOTAL" } },
              { c: "JSpinner", p: { label: "BUSY", showLabel: true } },
              { c: "JToggle", p: { label: "SWITCH", defaultChecked: true } },
              { c: "JSelect", p: { options: [{ value: "a", label: "Alpha" }], defaultValue: "a" } },
              { c: "JAccordion", p: { title: "MORE", defaultOpen: true }, kids: ["INSIDE"] },
            ],
          },
        }}
      />,
    );
    expect(await screen.findByText("TOTAL")).toBeTruthy();
    expect(screen.getByText("SWITCH")).toBeTruthy();
    expect(screen.getByText("INSIDE")).toBeTruthy();
    expect(container.querySelector(".obj-empty")).toBeNull();
  });

  it("lays parts out in a row and a grid", async () => {
    const { container } = render(<Jarvis props={{ ui: { c: "Row", kids: [{ c: "JStatusPill", p: { state: "success" }, kids: ["UP"] }, { c: "Grid", p: { columns: 2 }, kids: [{ c: "JBadge", kids: ["A"] }, { c: "JBadge", kids: ["B"] }] }] } }} />);
    expect(await screen.findByText("UP")).toBeTruthy();
    expect(container.querySelector(".jv-row")).toBeTruthy();
    expect((container.querySelector(".jv-grid") as HTMLElement).style.gridTemplateColumns).toBe("repeat(2, minmax(0, 1fr))");
  });

  it("draws nothing it was not allowed to, and says why", () => {
    const { container } = render(<Jarvis props={{ ui: { c: "JBadge", p: { onClick: "alert(1)" }, kids: ["x"] } }} />);
    expect(container.textContent).toMatch(/onClick/);
    expect(container.querySelector(".j-badge, [class*=JBadge]")).toBeNull();
    cleanup();
    expect(render(<Jarvis props={{ ui: { c: "JDesktop" } }} />).container.textContent).toMatch(/JDesktop/);
  });

  it("does not run markup it is given as text", async () => {
    const { container } = render(<Jarvis props={{ ui: { c: "JAlert", p: { state: "warning", title: "<img src=x onerror=alert(1)>" }, kids: ["<script>alert(1)</script>"] } }} />);
    await screen.findByText(/script/);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("limits the size of a grid and a gap, so a tree cannot break the layout", async () => {
    const { container } = render(<Jarvis props={{ ui: { c: "Grid", p: { columns: 500, gap: 9999 }, kids: [{ c: "JBadge", kids: ["A"] }] } }} />);
    await screen.findByText("A");
    const g = container.querySelector(".jv-grid") as HTMLElement;
    expect(g.style.gridTemplateColumns).toBe("repeat(6, minmax(0, 1fr))");
    expect(g.style.gap).toBe("32px");
  });
});