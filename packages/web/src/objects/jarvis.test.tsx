import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { Jarvis } from "./jarvis";

afterEach(cleanup);

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