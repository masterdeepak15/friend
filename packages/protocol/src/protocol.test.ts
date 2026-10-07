import { describe, expect, it } from "vitest";
import { ApprovalRespond, ClientMsg, Placement, StageCommand, StageObject } from "./index";

const obj = { id: "a", type: "card", props: { text: "hi" }, placement: "center" };

describe("stage schemas", () => {
  it("parses a valid show command", () => {
    expect(StageCommand.safeParse({ cmd: "show", object: obj }).success).toBe(true);
  });
  it("rejects a relative placement outside 0..1", () => {
    expect(Placement.safeParse({ x: 1.5, y: 0, w: 0.2, h: 0.2 }).success).toBe(false);
  });
  it("rejects an object type outside the catalog", () => {
    expect(StageObject.safeParse({ ...obj, type: "html" }).success).toBe(false);
  });
});

describe("client messages", () => {
  it("rejects an unknown approval decision", () => {
    expect(ApprovalRespond.safeParse({ type: "approval.respond", id: "1", decision: "maybe" }).success).toBe(false);
  });
  it("rejects an unknown message type", () => {
    expect(ClientMsg.safeParse({ type: "rm.rf" }).success).toBe(false);
  });
  it("accepts chat.send", () => {
    expect(ClientMsg.safeParse({ type: "chat.send", text: "hello" }).success).toBe(true);
  });
});
