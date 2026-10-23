import type { OfficeWorkerView } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { MAX_ZOOM, MIN_ZOOM, NODE_H, NODE_W, canvasLayout, clampView, fitView, zoomAt } from "./canvas";

const w = (id: string, managerId: string | null = null): OfficeWorkerView => ({ id, name: id, roleId: "", title: "T", capabilities: "", managerId, projectId: "p", status: "idle", ticketId: null, detail: "", tokens: 0, budget: null, startedAt: null });

describe("canvasLayout, the team in the room of a canvas", () => {
  it("puts each level one step to the right and each person in a row of their own, with a line for each report", () => {
    const l = canvasLayout([w("lena"), w("ben", "lena"), w("cy", "lena")]);
    const at = (id: string) => l.nodes.find((n) => n.id === id)!;
    expect(at("friend").x).toBe(0);
    expect(at("lena").x).toBeGreaterThan(at("friend").x + NODE_W);
    expect(at("ben").x).toBe(at("cy").x);
    expect(at("cy").y - at("ben").y).toBeGreaterThanOrEqual(NODE_H);
    expect(l.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["friend>lena", "lena>ben", "lena>cy"]);
    for (const e of l.edges) expect(e.x2).toBeGreaterThan(e.x1); // each line runs from a node's right side to the next one's left
    expect(l.width).toBeGreaterThanOrEqual(at("ben").x + NODE_W);
    expect(l.height).toBeGreaterThanOrEqual(at("cy").y + NODE_H);
  });

  it("is a single node for an empty team", () => {
    const l = canvasLayout([]);
    expect(l.nodes).toHaveLength(1);
    expect(l.edges).toEqual([]);
  });
});

describe("the view of the canvas", () => {
  const world = { width: 1000, height: 500 };
  const room = { width: 500, height: 400 };

  it("fits the whole team in the room, centred, never larger than life", () => {
    const v = fitView(world, room);
    expect(v.k).toBeLessThan(1);
    expect(v.k * world.width).toBeLessThanOrEqual(room.width);
    expect(v.k * world.height).toBeLessThanOrEqual(room.height);
    expect(v.x + (v.k * world.width) / 2).toBeCloseTo(room.width / 2, 0);
    expect(v.y + (v.k * world.height) / 2).toBeCloseTo(room.height / 2, 0);
    expect(fitView({ width: 100, height: 50 }, room).k).toBeLessThanOrEqual(1.25);
  });

  it("zooms around the point under the mouse, which stays where it is", () => {
    const v = { x: 40, y: 30, k: 1 };
    const z = zoomAt(v, { x: 200, y: 150 }, 2);
    expect(z.k).toBe(2);
    const worldX = (200 - v.x) / v.k;
    expect(z.x + worldX * z.k).toBeCloseTo(200, 5);
    expect(z.y + ((150 - v.y) / v.k) * z.k).toBeCloseTo(150, 5);
  });

  it("keeps the zoom within sensible limits", () => {
    expect(zoomAt({ x: 0, y: 0, k: 1 }, { x: 0, y: 0 }, 1000).k).toBe(MAX_ZOOM);
    expect(zoomAt({ x: 0, y: 0, k: 1 }, { x: 0, y: 0 }, 0.0001).k).toBe(MIN_ZOOM);
  });

  it("never lets the team be pushed out of the room: some of it always stays in view", () => {
    const far = clampView({ x: 99999, y: -99999, k: 1 }, world, room);
    expect(far.x).toBeLessThan(room.width);
    expect(far.y + world.height * far.k).toBeGreaterThan(0);
    expect(clampView({ x: -99999, y: 0, k: 1 }, world, room).x + world.width).toBeGreaterThan(0);
    const ok = { x: 10, y: 10, k: 1 };
    expect(clampView(ok, world, room)).toEqual(ok);
  });
});