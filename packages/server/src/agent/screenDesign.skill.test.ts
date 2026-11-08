import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { inspectPlugin, MAX_SKILL_BYTES } from "../plugins";
import { screenGuide } from "./guide";
import { LAYOUT_GUIDE } from "./layout";

const catalog = resolve(dirname(fileURLToPath(import.meta.url)), "../../../../plugins");

describe("the screen-design skill", () => {
  const r = inspectPlugin(join(catalog, "screen-design"));
  const text = r.ok ? (r.skillText.get("screen-design") ?? "") : "";

  it("is a valid bundled plugin with one skill of that name", () => {
    expect(r.ok).toBe(true);
    expect(r.ok && r.manifest.id).toBe("screen-design");
    expect(r.ok && r.manifest.skills.map((s) => s.name)).toEqual(["screen-design"]);
  });
  it("fits the skill size limit and is not a wall of text", () => {
    expect(text.length).toBeGreaterThan(1500);
    expect(Buffer.byteLength(text)).toBeLessThan(MAX_SKILL_BYTES);
  });
  it("teaches every role and the tool", () => {
    for (const w of ["screen.compose", "focus", "beside", "glance", "note", "alert", "replace", "add"]) expect(text).toContain(w);
  });
  it("says what to do on a phone, a tablet and a desktop, and gives recipes", () => {
    for (const w of ["phone", "tablet", "desktop", "weather", "schedule", "error", "chart", "compare"]) expect(text.toLowerCase()).toContain(w);
  });
  it("every recipe's JSON is valid and uses only the five roles", () => {
    const blocks = [...text.matchAll(/```json\n([\s\S]*?)```/g)].map((m) => m[1]!);
    expect(blocks.length).toBeGreaterThanOrEqual(4);
    for (const b of blocks) {
      const parsed = JSON.parse(b) as { items: { role: string }[]; mode?: string };
      for (const it of parsed.items) expect(["focus", "beside", "glance", "note", "alert"]).toContain(it.role);
    }
  });
});

describe("the shorter layout guide", () => {
  it("points to screen.compose and the skill", () => {
    expect(LAYOUT_GUIDE).toContain("screen.compose");
    expect(LAYOUT_GUIDE).toContain("screen-design");
  });
  it("no longer pushes a crowded control room", () => {
    expect(LAYOUT_GUIDE).not.toMatch(/up to 6 pictures/i);
    expect(LAYOUT_GUIDE).not.toMatch(/control room/i);
  });
  it("keeps the fixed parts of the screen and the colours", () => {
    for (const w of ["captions", "status line", "clock", "#3fd8ff", "pinned"]) expect(LAYOUT_GUIDE).toContain(w);
  });
  it("the layout topic of the manual mentions the roles", () => {
    expect(screenGuide("layout")).toContain("screen.compose");
  });

  it("says the beside places are small and that nothing put away is to be placed back by hand", () => {
    const r = inspectPlugin(join(catalog, "screen-design"));
    const text = r.ok ? (r.skillText.get("screen-design") ?? "") : "";
    expect(text).toMatch(/Beside places are small/);
    expect(text).toMatch(/do not put it back with `stage.show`/);
  });
});
