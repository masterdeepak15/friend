import { describe, expect, it } from "vitest";
import { OAuthTickets } from "./tickets";

describe("OAuthTickets", () => {
  it("a ticket works once", () => {
    const t = new OAuthTickets();
    const id = t.issueTicket("svc:google");
    expect(t.takeTicket(id)).toBe("svc:google");
    expect(t.takeTicket(id)).toBeNull();
  });

  it("a ticket and a state are not interchangeable", () => {
    const t = new OAuthTickets();
    const tk = t.issueTicket("svc:google");
    const st = t.issueState("svc:google");
    expect(t.takeState(tk)).toBeNull();
    expect(t.takeTicket(st)).toBeNull();
  });

  it("a state carries what it was made with, once", () => {
    const t = new OAuthTickets();
    const s = t.issueState("mcp:gmail", { verifier: "v1" });
    expect(t.takeState(s)).toEqual({ key: "mcp:gmail", extra: { verifier: "v1" } });
    expect(t.takeState(s)).toBeNull();
  });

  it("expires after ten minutes", () => {
    let now = 1_000;
    const t = new OAuthTickets(() => now);
    const tk = t.issueTicket("a");
    const st = t.issueState("a");
    now += 10 * 60_000 + 1;
    expect(t.takeTicket(tk)).toBeNull();
    expect(t.takeState(st)).toBeNull();
  });

  it("is still good just before ten minutes", () => {
    let now = 1_000;
    const t = new OAuthTickets(() => now);
    const st = t.issueState("a");
    now += 9 * 60_000;
    expect(t.takeState(st)?.key).toBe("a");
  });

  it("refuses unknown and non-text values", () => {
    const t = new OAuthTickets();
    expect(t.takeTicket("nope")).toBeNull();
    expect(t.takeState(undefined as unknown as string)).toBeNull();
    expect(t.takeTicket(42 as unknown as string)).toBeNull();
  });

  it("keeps at most twenty waiting and drops the oldest", () => {
    const t = new OAuthTickets();
    const first = t.issueState("k0");
    for (let i = 1; i <= 20; i++) t.issueState(`k${i}`);
    expect(t.takeState(first)).toBeNull();
  });
});
