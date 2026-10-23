import { describe, expect, it } from "vitest";
import { JARVIS_COMPONENTS, JARVIS_LIMITS, jarvisCatalog, jarvisProblem } from "./jarvis";

const ok = (ui: unknown) => jarvisProblem({ ui });

describe("what the assistant may draw with the Jarvis components", () => {
  it("accepts a small tree of known components with known props", () => {
    expect(ok({ c: "Column", kids: [{ c: "JStatCard", p: { title: "CPU", value: "42%", barValue: 42 } }, { c: "JBadge", p: { color: "green" }, kids: ["OK"] }] })).toBeNull();
    expect(ok({ c: "JNodeGraph", p: { nodes: [{ id: "a", label: "A", x: 10, y: 10 }], edges: [] } })).toBeNull();
  });

  it("needs a tree, and a component it knows", () => {
    expect(jarvisProblem({})).toMatch(/ui/);
    expect(jarvisProblem(null)).toMatch(/ui/);
    expect(ok({ c: "JDesktop" })).toMatch(/JDesktop.*not available/i);
    expect(ok({ c: 5 })).toMatch(/component/i);
    expect(ok("text")).toMatch(/component/i);
  });

  it("refuses props a component does not have, and anything that could run code or restyle the screen", () => {
    expect(ok({ c: "JBadge", p: { onClick: "x" } })).toMatch(/onClick/);
    expect(ok({ c: "JBadge", p: { style: { color: "red" } } })).toMatch(/style/);
    expect(ok({ c: "JBadge", p: { className: "x" } })).toMatch(/className/);
    expect(ok({ c: "JBadge", p: { dangerouslySetInnerHTML: { __html: "<b>" } } })).toMatch(/dangerouslySetInnerHTML/);
    expect(ok({ c: "JStatCard", p: { title: "x", value: "1", nonsense: 1 } })).toMatch(/nonsense/);
    expect(ok({ c: "JStatusPill", p: { label: "UP" } })).toMatch(/label/); // its text is the kids, as in the real component
  });

  it("only takes plain data in props", () => {
    expect(ok({ c: "JStatCard", p: { title: "x", value: "1", dataRows: [{ label: "a", value: "b" }] } })).toBeNull();
    expect(ok({ c: "JProgress", p: { value: () => 1 } })).toMatch(/plain data/i);
    expect(ok({ c: "JBadge", p: { color: "x".repeat(JARVIS_LIMITS.text + 1) } })).toMatch(/long/i);
  });

  it("keeps the tree small and shallow", () => {
    let deep: unknown = { c: "Column" };
    for (let i = 0; i < JARVIS_LIMITS.depth + 1; i++) deep = { c: "Column", kids: [deep] };
    expect(ok(deep)).toMatch(/deep/i);
    const wide = { c: "Row", kids: Array.from({ length: JARVIS_LIMITS.nodes + 1 }, () => ({ c: "JBadge", kids: ["x"] })) };
    expect(ok(wide)).toMatch(/many|big|large/i);
  });

  it("covers the library: charts, indicators, frames, forms, tabs and accordions, as well as cards", () => {
    for (const c of ["JDonutChart", "JRadarChart", "JSpinner", "JHudBar", "JHudFrameCard", "JOrb", "JButton", "JInput", "JToggle", "JSlider", "JCheckbox", "JSelect", "JTextArea", "JFormField", "JAccordion", "JTabs", "JTab"]) expect(JARVIS_COMPONENTS[c], c).toBeTruthy();
    expect(ok({ c: "JTabs", kids: [{ c: "JTab", p: { tabKey: "a", label: "A" }, kids: [{ c: "JBadge", kids: ["x"] }] }] })).toBeNull();
    expect(ok({ c: "JSelect", p: { options: [{ value: "a", label: "A" }], defaultValue: "a" } })).toBeNull();
  });

  it("never takes what runs or follows the person: no click or change handlers, no links, no controlled values", () => {
    expect(ok({ c: "JButton", p: { onClick: "x" } })).toMatch(/onClick/);
    expect(ok({ c: "JInput", p: { value: "x" } })).toMatch(/value/); // only defaultValue: a typed value would be lost to nobody
    expect(ok({ c: "JNavItem", p: { href: "https://example.com" } })).toMatch(/JNavItem/);
  });

  it("takes parts for the places a component keeps content other than its kids (a card's header and footer)", () => {
    expect(ok({ c: "JCard", slots: { header: ["TITLE"], footer: [{ c: "JBadge", kids: ["end"] }] }, kids: [{ c: "JBadge", kids: ["body"] }] })).toBeNull();
    expect(ok({ c: "JCard", slots: { nonsense: ["x"] } })).toMatch(/nonsense/);
    expect(ok({ c: "JBadge", slots: { header: ["x"] }, kids: ["y"] })).toMatch(/header/);
    expect(ok({ c: "JCard", slots: { header: [{ c: "JDesktop" }] } })).toMatch(/JDesktop/);
  });

  it("lists every component for the assistant, with its props, built from the same table", () => {
    const text = jarvisCatalog();
    for (const name of Object.keys(JARVIS_COMPONENTS)) expect(text, name).toContain(name);
    expect(text).toMatch(/JStatCard\b[^\n]*title/);
    expect(text).not.toMatch(/JDesktop|JWindow\b/);
  });
});