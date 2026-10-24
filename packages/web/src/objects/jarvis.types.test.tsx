import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { JARVIS_TYPES } from "@friend/protocol";
import { CATALOG } from "./objects";
import { JarvisObject } from "./jarvis";

afterEach(cleanup);

describe("every Jarvis component is an object type of the screen", () => {
  it("is in the catalog under its own name, next to the basic widgets", () => {
    for (const name of JARVIS_TYPES) expect(Object.keys(CATALOG), name).toContain(name);
    for (const basic of ["card", "stat", "gauge", "table", "sandbox"]) expect(Object.keys(CATALOG)).toContain(basic);
    expect(Object.keys(CATALOG)).not.toContain("jarvis");
  });

  it("draws a component from its type and props", async () => {
    render(<JarvisObject type="JStatCard" props={{ title: "CPU LOAD", value: "42%" }} />);
    expect(await screen.findByText("CPU LOAD")).toBeTruthy();
    expect(screen.getByText("42%")).toBeTruthy();
  });

  it("draws the parts inside a component (kids, and a card's header and footer)", async () => {
    render(<JarvisObject type="JCard" props={{ slots: { header: ["HEAD TEXT"], footer: [{ c: "JBadge", kids: ["FOOT"] }] }, kids: ["BODY TEXT", { c: "Row", kids: [{ c: "JStatusPill", p: { state: "success" }, kids: ["UP"] }] }] }} />);
    expect(await screen.findByText("HEAD TEXT")).toBeTruthy();
    expect(screen.getByText("FOOT")).toBeTruthy();
    expect(screen.getByText("BODY TEXT")).toBeTruthy();
    expect(screen.getByText("UP")).toBeTruthy();
  });

  it("draws tabs that switch", async () => {
    render(<JarvisObject type="JTabs" props={{ kids: [{ c: "JTab", p: { tabKey: "a", label: "FIRST" }, kids: ["PANEL A"] }, { c: "JTab", p: { tabKey: "b", label: "SECOND" }, kids: ["PANEL B"] }] }} />);
    expect(await screen.findByText("PANEL A")).toBeTruthy();
    fireEvent.click(screen.getByText("SECOND"));
    expect(await screen.findByText("PANEL B")).toBeTruthy();
  });

  it("draws nothing it was not allowed to, and says why", () => {
    const { container } = render(<JarvisObject type="JBadge" props={{ onClick: "alert(1)", kids: ["x"] }} />);
    expect(container.textContent).toMatch(/onClick/);
    cleanup();
    expect(render(<JarvisObject type="JDesktop" props={{}} />).container.textContent).toMatch(/JDesktop/);
  });

  it("does not run markup it is given as text", async () => {
    const { container } = render(<JarvisObject type="JAlert" props={{ state: "warning", title: "<img src=x onerror=alert(1)>", kids: ["<script>alert(1)</script>"] }} />);
    await screen.findByText(/script/);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});