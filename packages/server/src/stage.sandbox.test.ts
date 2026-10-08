import type { ServerMsg } from "@friend/protocol";
import { StageObject } from "@friend/protocol";
import { beforeEach, describe, expect, it } from "vitest";
import { MAX_SANDBOX_HTML, StageState, runStageTool } from "./stage";

const page = (html: unknown, id = "toy") => ({ id, type: "sandbox" as const, props: { html }, placement: "center" as const });
let stage: StageState;
let emitted: ServerMsg[];

beforeEach(() => {
  stage = new StageState();
  emitted = [];
});

describe("sandbox objects on the stage", () => {
  it("is a valid object type", () => {
    expect(StageObject.safeParse(page("<p>x</p>")).success).toBe(true);
  });

  it("accepts a page up to the size limit and refuses one over it", () => {
    expect(stage.apply({ cmd: "show", object: page("x".repeat(MAX_SANDBOX_HTML)) })).toEqual({ ok: true });
    const r = stage.apply({ cmd: "show", object: page("x".repeat(MAX_SANDBOX_HTML + 1), "big") });
    expect(r).toEqual({ ok: false, error: `A sandbox page can be at most ${MAX_SANDBOX_HTML} characters.` });
    expect(stage.snapshot().objects.map((o) => o.id)).toEqual(["toy"]);
  });

  it("refuses a page that is not text", () => {
    for (const bad of [undefined, 42, { a: 1 }, ["<p>"]]) {
      expect(stage.apply({ cmd: "show", object: page(bad) }).ok).toBe(false);
    }
  });

  it("applies the same limit when a page is updated", () => {
    stage.apply({ cmd: "show", object: page("<p>ok</p>") });
    expect(stage.apply({ cmd: "update", id: "toy", props: { html: "<p>new</p>" } })).toEqual({ ok: true });
    expect(stage.apply({ cmd: "update", id: "toy", props: { html: "x".repeat(MAX_SANDBOX_HTML + 1) } }).ok).toBe(false);
    expect(stage.apply({ cmd: "update", id: "toy", props: { title: "Nothing to do with html" } })).toEqual({ ok: true });
    expect((stage.snapshot().objects[0]!.props as { html: string }).html).toBe("<p>new</p>");
  });

  it("works through the stage.show tool and reports a refusal to the model in words", () => {
    const ok = runStageTool("stage.show", { object: page("<p>hi</p>") }, stage, (m) => emitted.push(m));
    expect(ok).toMatchObject({ ok: true });
    const bad = runStageTool("stage.show", { object: page("x".repeat(MAX_SANDBOX_HTML + 1), "b") }, stage, (m) => emitted.push(m));
    expect(bad).toEqual({ ok: false, error: expect.stringContaining("at most") });
    expect(emitted).toHaveLength(1); // only the good one was broadcast
  });

  it("does not let other object types smuggle an html prop past the check", () => {
    const card = { id: "c", type: "card" as const, props: { text: "hi", html: "x".repeat(MAX_SANDBOX_HTML + 5) }, placement: "center" as const };
    expect(stage.apply({ cmd: "show", object: card })).toEqual({ ok: true }); // ordinary objects are rendered as text, not run
  });
});
