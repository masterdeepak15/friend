import { describe, expect, it } from "vitest";
import { OBJECT_TYPES } from "./stage";
import { JARVIS_COMPONENTS, JARVIS_LIMITS, JARVIS_TYPES, isJarvisType, jarvisCatalog, jarvisNaturalSize, jarvisObjectProblem, jarvisProblem, jarvisTreeOf } from "./jarvis";

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
describe("how big a Jarvis drawing needs to be", () => {
  const ui = (n: unknown) => jarvisNaturalSize(n as never);

  it("knows the size of each component: a card is wider than tall, a pill is small, a gauge is square-ish", () => {
    expect(ui({ c: "JStatCard", p: { title: "CPU", value: "1%" } })).toMatchObject({ w: 260 });
    const card = ui({ c: "JStatCard", p: { title: "CPU", value: "1%" } });
    expect(card.w).toBeGreaterThan(card.h);
    expect(ui({ c: "JStatusPill" }).h).toBeLessThan(60);
    const g = ui({ c: "JGaugeChart", p: { value: 5, size: "200px" } });
    expect(Math.abs(g.w - g.h)).toBeLessThan(80);
  });

  it("grows with what is in it: more rows make a stat card taller, more rows make a table taller", () => {
    const a = ui({ c: "JStatCard", p: { title: "x", value: "1" } });
    const b = ui({ c: "JStatCard", p: { title: "x", value: "1", dataRows: [{ label: "a", value: "1" }, { label: "b", value: "2" }] } });
    expect(b.h).toBeGreaterThan(a.h + 40);
    const t1 = ui({ c: "JTable", p: { columns: [{ key: "a", label: "A" }], rows: [{ a: 1 }] } });
    const t3 = ui({ c: "JTable", p: { columns: [{ key: "a", label: "A" }], rows: [{ a: 1 }, { a: 2 }, { a: 3 }] } });
    expect(t3.h).toBeGreaterThan(t1.h);
  });

  it("adds up a row and a column, and lays a grid out in rows", () => {
    const pill = { c: "JStatusPill", kids: ["UP"] };
    const one = ui(pill);
    const row = ui({ c: "Row", p: { gap: 10 }, kids: [pill, pill] });
    expect(row.w).toBe(one.w * 2 + 10);
    expect(row.h).toBe(one.h);
    const col = ui({ c: "Column", p: { gap: 10 }, kids: [pill, pill, pill] });
    expect(col.h).toBe(one.h * 3 + 20);
    expect(col.w).toBe(one.w);
    const grid = ui({ c: "Grid", p: { columns: 2, gap: 0 }, kids: [pill, pill, pill, pill] });
    expect(grid.w).toBe(one.w * 2);
    expect(grid.h).toBe(one.h * 2);
  });

  it("adds the room a card or a frame takes around what is in it", () => {
    const inner = ui({ c: "JBadge", kids: ["x"] });
    expect(ui({ c: "JCard", kids: [{ c: "JBadge", kids: ["x"] }] }).w).toBeGreaterThan(inner.w);
    expect(ui({ c: "JCard", slots: { header: ["HEAD"] }, kids: [{ c: "JBadge", kids: ["x"] }] }).h).toBeGreaterThan(ui({ c: "JCard", kids: [{ c: "JBadge", kids: ["x"] }] }).h);
  });

  it("gives every size in the list the assistant reads", () => {
    expect(jarvisCatalog()).toMatch(/JStatCard[^\n]*about 260x\d+ px/);
    expect(jarvisCatalog()).toMatch(/JGaugeChart[^\n]*about \d+x\d+ px/);
  });

  it("never answers nonsense for a tree it does not understand", () => {
    const s = ui({ c: "Unknown" });
    expect(s.w).toBeGreaterThan(0);
    expect(s.h).toBeGreaterThan(0);
  });
});
describe("the Jarvis components are object types like the others", () => {
  it("are in OBJECT_TYPES, each by its own name, and there is no separate jarvis type", () => {
    for (const name of JARVIS_TYPES) expect(OBJECT_TYPES as readonly string[], name).toContain(name);
    expect(OBJECT_TYPES as readonly string[]).not.toContain("jarvis");
    for (const basic of ["card", "stat", "gauge", "table", "sandbox", "markdown"]) expect(OBJECT_TYPES as readonly string[]).toContain(basic); // the older ones stay
  });

  it("are every component of the library that is allowed, except the three layout words that only make sense inside a tree", () => {
    expect(JARVIS_TYPES).toEqual(expect.arrayContaining(["JStatCard", "JGaugeChart", "JTable", "JButton", "JCard", "JNodeGraph", "JBarChart"]));
    expect(JARVIS_TYPES).not.toContain("Row");
    expect(JARVIS_TYPES).not.toContain("Column");
    expect(JARVIS_TYPES).not.toContain("Grid");
    expect(JARVIS_TYPES.length).toBeGreaterThanOrEqual(40);
    expect(isJarvisType("JStatCard")).toBe(true);
    expect(isJarvisType("stat")).toBe(false);
  });

  it("an object of a Jarvis type draws that component with its props, and kids and slots for the parts inside", () => {
    expect(jarvisTreeOf("JCard", { color: "cyan", kids: ["hi"], slots: { header: ["HEAD"] } })).toEqual({ c: "JCard", p: { color: "cyan" }, kids: ["hi"], slots: { header: ["HEAD"] } });
    expect(jarvisTreeOf("JStatCard", { title: "CPU", value: "1%" })).toEqual({ c: "JStatCard", p: { title: "CPU", value: "1%" } });
  });

  it("is checked like a tree: unknown props, handlers and big trees are refused with a sentence", () => {
    expect(jarvisObjectProblem("JStatCard", { title: "CPU", value: "1%" })).toBeNull();
    expect(jarvisObjectProblem("JStatCard", { title: "CPU", onClick: "x" })).toMatch(/onClick/);
    expect(jarvisObjectProblem("JStatCard", { nonsense: 1 })).toMatch(/nonsense/);
    expect(jarvisObjectProblem("JCard", { kids: [{ c: "JDesktop" }] })).toMatch(/JDesktop/);
  });
});