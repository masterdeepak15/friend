import type { ServerMsg, StageCommand } from "@friend/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { StageState, runStageTool } from "./stage";

const card = (id: string, extra: object = {}) => ({
  id,
  type: "card" as const,
  props: { text: id },
  placement: "center" as const,
  ...extra,
});

let stage: StageState;
let emitted: ServerMsg[];
const emit = (m: ServerMsg) => emitted.push(m);

beforeEach(() => {
  stage = new StageState();
  emitted = [];
});

describe("StageState", () => {
  it("starts in conversation scene with idle presence and no objects", () => {
    const s = stage.snapshot();
    expect(s.scene).toBe("conversation");
    expect(s.objects).toEqual([]);
    expect(s.presence.state).toBe("idle");
  });
  it("shows an object and includes it in the snapshot", () => {
    expect(stage.apply({ cmd: "show", object: card("a") })).toEqual({ ok: true });
    expect(stage.snapshot().objects.map((o) => o.id)).toEqual(["a"]);
  });
  it("replaces an object shown twice with the same id", () => {
    stage.apply({ cmd: "show", object: card("a") });
    stage.apply({ cmd: "show", object: card("a", { props: { text: "new" } }) });
    expect(stage.snapshot().objects).toHaveLength(1);
    expect(stage.snapshot().objects[0]!.props).toEqual({ text: "new" });
  });
  it("update merges props and fails with the id for a missing object", () => {
    stage.apply({ cmd: "show", object: card("a") });
    expect(stage.apply({ cmd: "update", id: "a", props: { extra: 1 } })).toEqual({ ok: true });
    expect(stage.snapshot().objects[0]!.props).toEqual({ text: "a", extra: 1 });
    const r = stage.apply({ cmd: "update", id: "ghost", props: {} });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("ghost");
  });
  it("hide removes an object and errors for a missing one", () => {
    stage.apply({ cmd: "show", object: card("a") });
    expect(stage.apply({ cmd: "hide", id: "a" })).toEqual({ ok: true });
    expect(stage.snapshot().objects).toEqual([]);
    expect(stage.apply({ cmd: "hide", id: "a" }).ok).toBe(false);
  });
  it("clear empties objects and returns to conversation", () => {
    stage.apply({ cmd: "scene", mode: "multi" });
    stage.apply({ cmd: "show", object: card("a") });
    stage.apply({ cmd: "clear" });
    expect(stage.snapshot().objects).toEqual([]);
    expect(stage.snapshot().scene).toBe("conversation");
  });
  it("expires objects whose ttl has passed", () => {
    const t0 = 1_000_000;
    stage.apply({ cmd: "show", object: card("a", { ttl: 5 }) }, t0);
    stage.apply({ cmd: "show", object: card("b") }, t0);
    expect(stage.expire(t0 + 4000)).toEqual([]);
    expect(stage.expire(t0 + 6000)).toEqual(["a"]);
    expect(stage.snapshot().objects.map((o) => o.id)).toEqual(["b"]);
  });
  it("rejects a 13th simultaneous object with a clear error", () => {
    for (let i = 0; i < 12; i++) expect(stage.apply({ cmd: "show", object: card(`o${i}`) }).ok).toBe(true);
    const r = stage.apply({ cmd: "show", object: card("o12") });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/12/);
  });
  it("applies presence and mood", () => {
    stage.apply({ cmd: "presence", state: "thinking" });
    stage.apply({ cmd: "mood", accent: "#ffb454", intensity: 0.5 });
    const s = stage.snapshot();
    expect(s.presence.state).toBe("thinking");
    expect(s.mood).toEqual({ accent: "#ffb454", intensity: 0.5 });
  });
});

describe("presence styles and new objects", () => {
  it("defaults to the sphere and switches style through the tool", () => {
    expect(stage.snapshot().presence.style).toBe("sphere");
    expect(runStageTool("stage.presence", { style: "orb" }, stage, emit).ok).toBe(true);
    expect(stage.snapshot().presence.style).toBe("orb");
    expect(emitted).toHaveLength(1);
  });
  it("rejects an unknown presence style with a helpful error and changes nothing", () => {
    const r = runStageTool("stage.presence", { style: "hologram" }, stage, emit);
    expect(r.ok).toBe(false);
    expect(stage.snapshot().presence.style).toBe("sphere");
    expect(emitted).toEqual([]);
  });
  it("shows a chart with auto placement", () => {
    const obj = { id: "c", type: "chart", props: { kind: "line", labels: ["a"], series: [{ name: "s", values: [1] }] }, placement: "auto" };
    expect(runStageTool("stage.show", { object: obj }, stage, emit).ok).toBe(true);
    expect(stage.snapshot().objects[0]!.type).toBe("chart");
  });
});

describe("runStageTool", () => {
  it("emits exactly one stage message per successful command", () => {
    const r = runStageTool("stage.show", { object: card("a") }, stage, emit);
    expect(r.ok).toBe(true);
    expect(emitted).toEqual([{ type: "stage", command: { cmd: "show", object: card("a") } satisfies StageCommand }]);
  });
  it("emits nothing and returns an error for an invalid command", () => {
    const r = runStageTool("stage.update", { id: "ghost", props: {} }, stage, emit);
    expect(r.ok).toBe(false);
    expect(emitted).toEqual([]);
  });
  it("rejects invalid arguments with a helpful error", () => {
    const r = runStageTool("stage.show", { object: { id: "x", type: "html" } }, stage, emit);
    expect(r.ok).toBe(false);
    expect(emitted).toEqual([]);
  });
  it("rejects unknown stage tools", () => {
    expect(runStageTool("stage.explode", {}, stage, emit).ok).toBe(false);
  });
});
