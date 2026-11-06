import { describe, expect, it } from "vitest";
import { buildSystemPrompt } from "./prompt";

describe("the assistant knows about approvals on the phone", () => {
  it("is told where they are asked and what it must not guess", () => {
    const p = buildSystemPrompt("Maya", "empty", "owner");
    expect(p).toMatch(/also asks them on their phone/);
    expect(p).toMatch(/Allow and Deny buttons/);
    expect(p).toMatch(/nobody answered in time/);
  });

  it("knows she can reach the owner in any available way, and not to leave important news only on the screen", () => {
    const p = buildSystemPrompt("Maya", "empty", "owner");
    expect(p).toMatch(/reach the owner in any way that is available/);
    expect(p).toMatch(/Telegram, WhatsApp or SMS/);
    expect(p).toMatch(/Never leave important news only on a screen nobody may be looking at/);
    expect(p).toMatch(/use owner\.notify/);
  });
});
