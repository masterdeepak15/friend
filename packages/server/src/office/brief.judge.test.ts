import { describe, expect, it } from "vitest";
import { sanitizeOffice } from "../config";
import { officeBrief } from "./brief";

describe("the assistant is told what 'Your assistant decides' means", () => {
  const brief = officeBrief(sanitizeOffice({ enabled: true, autonomy: "judge", projects: [] }));
  it("knows a refusal or allow comes from the Office's check, and where the reasons are", () => {
    expect(brief).toMatch(/Autonomy is JUDGE/);
    expect(brief).toMatch(/The assistant refused: <reason>/);
    expect(brief).toMatch(/Office feed and in the audit log/);
  });
  it("is told how to test it", () => {
    expect(brief).toMatch(/an install, a delete, a network call/);
  });
});
