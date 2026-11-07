import { describe, expect, it } from "vitest";
import { FEATURE_PREREQ } from "./commands/onboard";
import { checkDocker } from "./commands/onboard/prereq";

describe("code running no longer needs Docker", () => {
  it("picking safe code running makes the wizard check nothing extra", () => {
    expect(FEATURE_PREREQ.sandbox).toBeUndefined();
  });

  it("doctor describes Docker as the optional stronger choice", async () => {
    const c = await checkDocker({ run: async () => ({ code: 1, stdout: "", stderr: "" }) } as never);
    expect(c.need).toBe("optional");
    expect(c.unlocks).toMatch(/built-in sandbox/);
  });
});
