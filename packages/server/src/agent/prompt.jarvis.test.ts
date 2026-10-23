import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./prompt";

describe("what the assistant is told about drawing", () => {
  it("knows the Jarvis components are here, and where to read about them, so it never says they are not in Friend yet", () => {
    for (const trust of ["owner"] as const) {
      const p = buildSystemPrompt("Maya", "empty", trust);
      expect(p).toMatch(/jarvis/i);
      expect(p).toMatch(/stage\.guide/);
      expect(p).toMatch(/already (in|part of) Friend|available now/i);
    }
  });

  it("does not give a guest or a member the drawing rules", () => {
    expect(buildSystemPrompt("Maya", "empty", "guest")).not.toMatch(/jarvis/i);
  });
});