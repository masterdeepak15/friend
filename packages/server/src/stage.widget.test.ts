import type { ServerMsg } from "@friend/protocol";
import { StageCommand, TOOL_DEFS, describeCall } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { StageState, runStageTool } from "./stage";

const run = (stage: StageState, args: unknown) => {
  const sent: ServerMsg[] = [];
  const r = runStageTool("stage.widget", args, stage, (m) => sent.push(m));
  return { r, sent };
};

describe("the live instruments of the home screen", () => {
  it("none are up until the assistant brings one up, and the screens are told", () => {
    const s = new StageState();
    expect(s.snapshot().widgets).toEqual([]);
    const { r, sent } = run(s, { show: ["system", "voice"] });
    expect(r.ok).toBe(true);
    expect(s.snapshot().widgets).toEqual(["system", "voice"]);
    expect(sent).toEqual([{ type: "stage", command: { cmd: "widget", show: ["system", "voice"] } }]);
  });

  it("puts some away, and all of them with reset", () => {
    const s = new StageState();
    run(s, { show: ["system", "voice", "network"] });
    run(s, { hide: ["voice"] });
    expect(s.snapshot().widgets).toEqual(["system", "network"]);
    run(s, { show: ["feed"], hide: ["network"] });
    expect(s.snapshot().widgets).toEqual(["system", "feed"]);
    run(s, { reset: true });
    expect(s.snapshot().widgets).toEqual([]);
  });

  it("stage.clear puts them away too, but leaves the owner's pinned widgets", () => {
    const s = new StageState();
    run(s, { show: ["radar", "tickets"] });
    runStageTool("stage.clear", {}, s, () => {});
    expect(s.snapshot().widgets).toEqual([]);
  });

  it("only the six live instruments can be named, and a call must name something", () => {
    const s = new StageState();
    expect(run(s, { show: ["budget"] }).r.ok).toBe(false); // the budget ring and approvals are the owner's, not the assistant's
    expect(run(s, { show: ["approval"] }).r.ok).toBe(false);
    expect(run(s, {}).r.ok).toBe(false);
    expect(run(s, { show: [] }).r.ok).toBe(false);
    expect(StageCommand.safeParse({ cmd: "widget", show: ["system"] }).success).toBe(true);
    expect(StageCommand.safeParse({ cmd: "widget", show: ["usage"] }).success).toBe(false);
  });

  it("is a tool that needs no approval, and says what it does on a card", () => {
    const def = TOOL_DEFS.find((t) => t.name === "stage.widget")!;
    expect(def).toMatchObject({ baseTier: "T0", target: "gateway" });
    expect(describeCall("stage.widget", { show: ["system"] })).toMatch(/system/);
    expect(describeCall("stage.widget", { reset: true })).toMatch(/Put away/);
  });
});
