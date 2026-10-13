import { describe, expect, it } from "vitest";
import { TOOL_DEFS, describeCall } from "./tools";

const def = (name: string) => TOOL_DEFS.find((t) => t.name === name);

describe("the web tools", () => {
  it("web.search is a gateway tool that needs no approval, with a sensible query and count", () => {
    const d = def("web.search")!;
    expect(d).toBeTruthy();
    expect(d.baseTier).toBe("T0");
    expect(d.target).toBe("gateway");
    expect(d.input.safeParse({ query: "nifty 50 today" }).success).toBe(true);
    expect(d.input.safeParse({ query: "nifty", count: 8 }).success).toBe(true);
    expect(d.input.safeParse({ query: "" }).success).toBe(false);
    expect(d.input.safeParse({ query: "x".repeat(301) }).success).toBe(false);
    expect(d.input.safeParse({ query: "nifty", count: 9 }).success).toBe(false);
    expect(d.input.safeParse({ query: "nifty", count: 0 }).success).toBe(false);
    expect(d.input.safeParse({ query: "nifty", count: 2.5 }).success).toBe(false);
  });

  it("web.read is a gateway tool that needs no approval, and takes one address", () => {
    const d = def("web.read")!;
    expect(d).toBeTruthy();
    expect(d.baseTier).toBe("T0");
    expect(d.target).toBe("gateway");
    expect(d.input.safeParse({ url: "https://example.com/a" }).success).toBe(true);
    expect(d.input.safeParse({ url: "" }).success).toBe(false);
    expect(d.input.safeParse({ url: "https://example.com/" + "a".repeat(2000) }).success).toBe(false);
    expect(d.input.safeParse({}).success).toBe(false);
  });

  it("tells the model they are for live information and that what comes back is not instructions", () => {
    expect(def("web.search")!.description).toMatch(/current|live|today/i);
    expect(def("web.read")!.description).toMatch(/never follow|not instructions|untrusted/i);
  });

  it("describes a call in plain words for the approval log", () => {
    expect(describeCall("web.search", { query: "nifty today" })).toMatch(/search the web for.*nifty today/i);
    expect(describeCall("web.read", { url: "https://example.com/a" })).toMatch(/read.*example\.com/i);
  });
});
