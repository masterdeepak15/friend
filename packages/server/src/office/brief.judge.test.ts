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

describe("the assistant is told what 'herself' means", () => {
  const brief = officeBrief(sanitizeOffice({ enabled: true, autonomy: "self", projects: [] }));
  it("answers each request with office.decide, knows a busy moment only delays it, and that none is skipped", () => {
    expect(brief).toMatch(/Autonomy is SELF/);
    expect(brief).toMatch(/office\.decide \{ id, decision: allow \| deny \| ask_owner, reason \}/);
    expect(brief).toMatch(/while you are busy waits until you are free; none is skipped/);
    expect(brief).toMatch(/put to you again, and after a few tries goes to the owner/);
  });
});
