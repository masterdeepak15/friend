import type { ScreenInfo, ServerMsg } from "@friend/protocol";
import { SAFE, rectOf } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { StageState, runStageTool } from "./stage";

const DESKTOP: ScreenInfo = { width: 1920, height: 1080, kind: "desktop", orientation: "landscape", touch: false };
const PHONE: ScreenInfo = { width: 390, height: 844, kind: "phone", orientation: "portrait", touch: true };
const item = (id: string, role: string, extra: object = {}) => ({ id, type: "card", props: { title: id, text: id }, role, ...extra });

function run(stage: StageState, args: unknown, sent: ServerMsg[] = []) {
  return runStageTool("screen.compose", args, stage, (m) => sent.push(m));
}
const objs = (s: StageState) => s.snapshot().objects;
const commands = (sent: ServerMsg[]) => sent.flatMap((m) => (m.type === "stage" ? [m.command] : []));

describe("screen.compose on a real stage", () => {
  it("a focus and a card beside land inside the safe area and say what happened", () => {
    const s = new StageState();
    s.setScreen(DESKTOP);
    const sent: ServerMsg[] = [];
    const out = run(s, { items: [item("f", "focus"), item("b", "beside")] }, sent);
    expect(out).toMatchObject({ ok: true });
    expect((out as { output: string }).output).toMatch(/f.*focus/);
    for (const o of objs(s)) {
      const r = rectOf(o.placement)!;
      expect(r[0]).toBeGreaterThanOrEqual(SAFE[0] - 0.01);
      expect(r[1] + r[3]).toBeLessThanOrEqual(SAFE[1] + SAFE[3] + 0.01);
    }
    expect(commands(sent).filter((c) => c.cmd === "show")).toHaveLength(2);
  });

  it("a second compose in replace mode puts the first focus away as a chip and keeps a pinned widget", () => {
    const s = new StageState();
    s.setScreen(DESKTOP);
    s.apply({ cmd: "show", object: { id: "w", type: "card", props: { text: "w" }, placement: { x: 0.8, y: 0.12, w: 0.15, h: 0.2 }, pinned: true } });
    run(s, { items: [item("one", "focus")] });
    const sent: ServerMsg[] = [];
    run(s, { items: [item("two", "focus")], mode: "replace" }, sent);
    expect(objs(s).find((o) => o.id === "one")?.docked).toBe(true);
    expect(objs(s).find((o) => o.id === "w")?.docked).toBeUndefined();
    expect(commands(sent).some((c) => c.cmd === "dock" && c.id === "one")).toBe(true);
  });

  it("an alert shows alone in alert style and the focus scene", () => {
    const s = new StageState();
    s.setScreen(DESKTOP);
    run(s, { items: [item("f", "focus")] });
    run(s, { items: [item("bad", "alert")] });
    expect(objs(s).find((o) => o.id === "bad")?.style).toBe("alert");
    expect(s.snapshot().scene).toBe("focus");
    expect(objs(s).find((o) => o.id === "f")?.docked).toBe(true);
  });

  it("a call that cannot be done changes nothing and says why in plain words", () => {
    const s = new StageState();
    s.setScreen(DESKTOP);
    for (let i = 0; i < 6; i++) s.apply({ cmd: "show", object: { id: `p${i}`, type: "card", props: { text: "p" }, placement: "auto", pinned: true } });
    for (let i = 0; i < 6; i++) {
      s.apply({ cmd: "show", object: { id: `x${i}`, type: "card", props: { text: "x" }, placement: "auto" } });
      s.apply({ cmd: "place", id: `x${i}`, placement: { x: 0.3, y: 0.2, w: 0.1, h: 0.1 } }, Date.now(), true); // the owner placed them: they stay
    }
    const before = JSON.stringify(s.snapshot());
    const sent: ServerMsg[] = [];
    const out = run(s, { items: Array.from({ length: 4 }, (_, i) => item(`n${i}`, "beside")), mode: "add" }, sent);
    expect(out).toMatchObject({ ok: false });
    expect(JSON.stringify(s.snapshot())).toBe(before);
    expect(sent).toEqual([]);
  });

  it("an item whose props are refused changes nothing at all", () => {
    const s = new StageState();
    s.setScreen(DESKTOP);
    run(s, { items: [item("ok", "focus")] });
    const before = JSON.stringify(s.snapshot());
    const bad = { id: "page", type: "sandbox", props: { html: "x".repeat(200_000) }, role: "beside" };
    expect(run(s, { items: [item("fine", "beside"), bad], mode: "add" })).toMatchObject({ ok: false });
    expect(JSON.stringify(s.snapshot())).toBe(before);
  });

  it("composing the same id again updates it in place", () => {
    const s = new StageState();
    s.setScreen(DESKTOP);
    run(s, { items: [item("a", "focus")] });
    run(s, { items: [{ ...item("a", "focus"), props: { title: "a", text: "newer" } }], mode: "add" });
    expect(objs(s).filter((o) => o.id === "a")).toHaveLength(1);
    expect(objs(s).find((o) => o.id === "a")?.props.text).toBe("newer");
  });
});

describe("restoring a chip", () => {
  it("brings it back and puts the oldest card beside away when full", () => {
    const s = new StageState();
    s.setScreen(DESKTOP);
    run(s, { items: [item("f", "focus"), item("b1", "beside"), item("b2", "beside"), item("b3", "beside")] });
    run(s, { items: [item("g", "glance")], mode: "add" });
    s.apply({ cmd: "dock", id: "b3", docked: true });
    s.apply({ cmd: "show", object: { id: "b4", type: "card", props: { text: "b4" }, placement: "auto", role: "beside" } });
    const r = s.restore("b3");
    expect(r.ok).toBe(true);
    expect(objs(s).find((o) => o.id === "b3")?.docked).toBeUndefined();
    expect(objs(s).filter((o) => o.role === "beside" && !o.docked).length).toBeLessThanOrEqual(3);
  });
  it("an unknown id is refused", () => {
    expect(new StageState().restore("nope")).toMatchObject({ ok: false });
  });
});
