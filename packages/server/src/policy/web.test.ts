import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../config";
import { openDb } from "../db";
import { PolicyEngine } from "./engine";
import { toolSpecs } from "../tools/registry";

function engine() {
  const dir = mkdtempSync(join(tmpdir(), "friend-policy-web-"));
  return new PolicyEngine(openDb(dir), loadConfig(dir));
}
const decide = (e: PolicyEngine, tool: string, trust: "owner" | "member" | "guest" | "voice-device") => e.decide({ tool, baseTier: "T0", args: {}, trust, insideRoots: true });

describe("who may search the web", () => {
  it("the owner may search and read without being asked", () => {
    const e = engine();
    expect(decide(e, "web.search", "owner")).toBe("allow");
    expect(decide(e, "web.read", "owner")).toBe("allow");
  });

  it("a household member may search, but not read pages", () => {
    const e = engine();
    expect(decide(e, "web.search", "member")).toBe("allow");
    expect(decide(e, "web.read", "member")).toBe("deny");
  });

  it("a guest may do neither", () => {
    const e = engine();
    expect(decide(e, "web.search", "guest")).toBe("deny");
    expect(decide(e, "web.read", "guest")).toBe("deny");
  });

  it("a speaker in the room (Alexa) may do neither unless the owner allowed it", () => {
    const e = engine();
    expect(decide(e, "web.search", "voice-device")).toBe("deny");
    expect(decide(e, "web.read", "voice-device")).toBe("deny");
  });

  it("both are on the list of tools the model is offered", () => {
    const names = toolSpecs().map((t) => t.name);
    expect(names).toContain("web.search");
    expect(names).toContain("web.read");
  });
});
