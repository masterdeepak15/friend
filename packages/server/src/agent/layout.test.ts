import { REGIONS, clampToSafe, overlap, rectOf, SAFE, type StageObject } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { StageState, runStageTool } from "../stage";
import { LAYOUT_GUIDE, describeScreen, placeObject, regionUse } from "./layout";
import { buildSystemPrompt } from "./prompt";

const obj = (id: string, placement: StageObject["placement"], type: StageObject["type"] = "card"): StageObject => ({ id, type, props: { text: id }, placement });

describe("geometry", () => {
  it("knows the named regions, and that auto has no box", () => {
    expect(rectOf("left")).toEqual(REGIONS.left);
    expect(rectOf("auto")).toBeNull();
    expect(rectOf({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 })!.map(Math.round)).toEqual([10, 20, 30, 40]);
  });
  it("measures how much of the smaller box is covered", () => {
    expect(overlap(REGIONS.left, REGIONS.right)).toBe(0);
    expect(overlap(REGIONS.center, REGIONS.center)).toBe(1);
    expect(overlap(REGIONS.center, REGIONS.left)).toBeGreaterThan(0.25);
  });
  it("pulls a box that sticks out back into the safe area, and keeps it from being tiny", () => {
    const [x, y, w, h] = clampToSafe([-10, 0, 150, 120]);
    expect(x).toBeGreaterThanOrEqual(SAFE[0]);
    expect(y).toBeGreaterThanOrEqual(SAFE[1]);
    expect(x + w).toBeLessThanOrEqual(SAFE[0] + SAFE[2]);
    expect(y + h).toBeLessThanOrEqual(SAFE[1] + SAFE[3]);
    expect(clampToSafe([50, 50, 1, 1])[2]).toBeGreaterThanOrEqual(12);
  });
});

describe("placeObject", () => {
  it("leaves an object where it asked when the spot is free", () => {
    expect(placeObject(obj("a", "left"), [obj("b", "right")])).toEqual({ object: obj("a", "left") });
    expect(placeObject(obj("a", "auto"), [obj("b", "left")]).note).toBeUndefined();
  });

  it("moves it to a free region and says why when the spot is taken", () => {
    const r = placeObject(obj("chart", "left", "chart"), [obj("note", "left")]);
    expect(r.object.placement).toBe("right");
    expect(r.note).toMatch(/right instead of left/);
    expect(r.note).toMatch(/"note"/);
  });

  it("falls back to auto when nothing is free", () => {
    const r = placeObject(obj("n", "center"), [obj("a", "left"), obj("b", "right")]);
    expect(r.object.placement).not.toBe("center");
    const crowded = placeObject(obj("n", "left"), [obj("a", "left"), obj("b", "right"), obj("c", "center"), obj("d", "bottom"), obj("e", "top")]);
    expect(crowded.object.placement).toBe("auto");
  });

  it("treats the auto grid as using the middle of the screen", () => {
    const r = placeObject(obj("n", "center"), [obj("a", "auto"), obj("b", "auto")]);
    expect(r.object.placement).toBe("auto");
  });

  it("does not collide with itself when an object is shown again with the same id", () => {
    const r = placeObject(obj("same", "left"), [obj("same", "left")]);
    expect(r.note).toBeUndefined();
  });

  it("moves a custom box that sticks out into the safe area", () => {
    const r = placeObject({ ...obj("x", "auto"), placement: { x: 0.0, y: 0.0, w: 0.5, h: 0.5 } }, []);
    expect(r.note).toMatch(/safe area/);
    const p = r.object.placement as { x: number; y: number };
    expect(p.y).toBeGreaterThanOrEqual(SAFE[1] / 100 - 0.001);
    expect(p.x).toBeGreaterThanOrEqual(SAFE[0] / 100 - 0.001);
  });
});

describe("what the model is told about the screen", () => {
  it("says the stage is empty when it is", () => {
    expect(describeScreen("conversation", "idle", [], 0)).toContain("empty");
  });
  it("lists each object with its place and how long it stays, and the free regions", () => {
    const text = describeScreen("multi", "idle", [{ object: obj("cpu", "left", "gauge"), expiresAt: null }, { object: obj("note", "right"), expiresAt: 30_000 }], 0);
    expect(text).toContain("cpu (gauge, left, stays)");
    expect(text).toContain("note (card, right, leaves in 30s)");
    expect(text).toMatch(/free regions: [a-z, ]*top/);
    expect(text).not.toMatch(/free regions: [a-z, ]*left/);
  });
  it("counts the regions in use", () => {
    const { used, free } = regionUse([obj("a", "left")]);
    expect([...used.keys()]).toContain("left");
    expect(free).toContain("right");
  });
});

describe("through the stage tool", () => {
  it("applies the adjusted placement, shows the adjusted object, and tells the model", () => {
    const stage = new StageState();
    const sent: unknown[] = [];
    const show = (o: StageObject) => runStageTool("stage.show", { object: o }, stage, (m) => sent.push(m));
    expect(show(obj("one", "left"))).toMatchObject({ ok: true, output: "ok" });
    const second = show(obj("two", "left"));
    expect(second).toMatchObject({ ok: true });
    expect((second as { output: string }).output).toMatch(/Placement changed.*right instead of left/);
    const placements = Object.fromEntries(stage.snapshot().objects.map((o) => [o.id, o.placement]));
    expect(placements).toEqual({ one: "left", two: "right" });
    expect(JSON.stringify(sent.at(-1))).toContain('"right"'); // the screen is told the adjusted placement
  });
});

describe("the design guide", () => {
  it("is in the owner's prompt, with the regions and the always-visible parts named", () => {
    const p = buildSystemPrompt("Jarvis", "scene=conversation");
    expect(p).toContain(LAYOUT_GUIDE);
    for (const w of ["status line", "clock", "captions", "free regions", "ttl", "auto"]) expect(LAYOUT_GUIDE).toContain(w);
  });
  it("is not given to a guest, who gets no screen details", () => {
    expect(buildSystemPrompt("Jarvis", "scene=conversation", "guest")).not.toContain("Screen layout");
  });
});

describe("the owner's open panels", () => {
  it("count as taken: nothing is placed on them", () => {
    const r = placeObject(obj("chart", "right", "chart"), [], ["chat"]);
    expect(r.object.placement).not.toBe("right");
    expect(r.note).toContain("the chat panel (right edge)");
    const left = placeObject(obj("n", "left"), [], ["tasks"]);
    expect(left.object.placement).not.toBe("left");
    expect(left.note).toMatch(/schedule panel/);
  });
  it("leave the other side free", () => {
    expect(placeObject(obj("c", "left"), [], ["chat"]).note).toBeUndefined();
  });
  it("are named in what the AI is told, and take their regions off the free list", () => {
    const text = describeScreen("conversation", "idle", [], 0, ["chat", "tasks"]);
    expect(text).toContain("the chat panel (right edge)");
    expect(text).toContain("the schedule panel (upper left)");
    expect(text).not.toMatch(/free regions: [a-z, ]*(left|right)/);
    expect(describeScreen("conversation", "idle", [], 0, [])).toMatch(/free regions: .*left.*right/);
  });
});
