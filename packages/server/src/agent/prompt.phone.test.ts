import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./prompt";

describe("the assistant knows about approvals on the phone", () => {
  it("is told where they are asked and what it must not guess", () => {
    const p = buildSystemPrompt("Maya", "empty", "owner");
    expect(p).toMatch(/also asks them on their phone/);
    expect(p).toMatch(/Allow and Deny buttons/);
    expect(p).toMatch(/nobody answered in time/);
  });
});
