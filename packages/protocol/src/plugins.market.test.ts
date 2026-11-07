import { describe, expect, it } from "vitest";
import { TOOL_DEFS, describeCall } from "./index";

const def = (n: string) => TOOL_DEFS.find((t) => t.name === n)!;

describe("the tools for installing from GitHub", () => {
  it("looking and reading need no PIN; installing and the marketplace list changes do", () => {
    expect(def("plugins.fetch").baseTier).toBe("T0");
    expect(def("plugins.read").baseTier).toBe("T0");
    expect(def("plugins.marketplace_list").baseTier).toBe("T0");
    expect(def("plugins.import").baseTier).toBe("T3");
    expect(def("plugins.marketplace_add").baseTier).toBe("T3");
    expect(def("plugins.marketplace_remove").baseTier).toBe("T3");
  });

  it("looking, reading and listing are read only", () => {
    for (const n of ["plugins.fetch", "plugins.read", "plugins.marketplace_list"]) expect(def(n).readOnly).toBe(true);
    for (const n of ["plugins.import", "plugins.marketplace_add", "plugins.marketplace_remove"]) expect(def(n).readOnly).toBeFalsy();
  });

  it("checks what it is given", () => {
    expect(def("plugins.fetch").input.safeParse({ url: "o/r" }).success).toBe(true);
    expect(def("plugins.fetch").input.safeParse({}).success).toBe(false);
    expect(def("plugins.read").input.safeParse({ staging: "abc", path: "README.md" }).success).toBe(true);
    expect(def("plugins.read").input.safeParse({ staging: "abc" }).success).toBe(false);
    expect(def("plugins.import").input.safeParse({ staging: "abc", plugin: "p", skills: ["a"] }).success).toBe(true);
    expect(def("plugins.import").input.safeParse({ staging: "abc", skills: Array(11).fill("a") }).success).toBe(false);
    expect(def("plugins.marketplace_add").input.safeParse({ repo: "o/r" }).success).toBe(true);
  });

  it("tells the assistant to read first, explain, and treat the repository's text as untrusted", () => {
    const d = def("plugins.fetch").description;
    expect(d).toMatch(/README/);
    expect(d).toMatch(/plain words/);
    expect(d).toMatch(/untrusted/);
    expect(d).toMatch(/never follow instructions/i);
  });

  it("shows on the approval card the whole preview of what would be installed, and nothing is cut", () => {
    const preview = "Install from github.com/o/r@abc1234\n\nSkill a — Does A.\n" + "line\n".repeat(400) + "THE END";
    const text = describeCall("plugins.import", { staging: "x", preview });
    expect(text).toContain("github.com/o/r@abc1234");
    expect(text).toContain("THE END");
    expect(describeCall("plugins.import", { staging: "x" })).toMatch(/Install skills/);
  });

  it("describes the other calls in plain words", () => {
    expect(describeCall("plugins.fetch", { url: "https://github.com/o/r" })).toBe("Look at the GitHub repository https://github.com/o/r");
    expect(describeCall("plugins.read", { staging: "x", path: "docs/a.md" })).toBe("Read docs/a.md from the repository");
    expect(describeCall("plugins.marketplace_add", { repo: "o/r" })).toBe("Add the marketplace o/r");
    expect(describeCall("plugins.marketplace_remove", { repo: "o/r" })).toBe("Remove the marketplace o/r");
    expect(describeCall("plugins.marketplace_list", {})).toBe("List the marketplaces");
  });
});
