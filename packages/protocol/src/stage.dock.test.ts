import { describe, expect, it } from "vitest";
import { StageCommand, StageObject } from "./stage";

const base = { id: "w", type: "card", props: {}, placement: "auto" } as const;

describe("roles, docked state and the dock command", () => {
  it("accepts a role, a docked flag and a short label", () => {
    expect(StageObject.safeParse({ ...base, role: "focus", docked: true, label: "24 C" }).success).toBe(true);
  });
  it("rejects an unknown role and a label over 40 characters", () => {
    expect(StageObject.safeParse({ ...base, role: "hero" }).success).toBe(false);
    expect(StageObject.safeParse({ ...base, label: "x".repeat(41) }).success).toBe(false);
  });
  it("accepts a dock command and rejects one without an id", () => {
    expect(StageCommand.safeParse({ cmd: "dock", id: "w", docked: true }).success).toBe(true);
    expect(StageCommand.safeParse({ cmd: "dock", docked: true }).success).toBe(false);
  });
});
