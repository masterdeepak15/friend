import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildSkillPlugin, discoverSkills, matchesAllow, mcpEntry, normServer, skillRootsOf, toolServer } from "./capabilities";

const skill = (dir: string, name: string, description: string) => {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, "SKILL.md"), `---\nname: ${name}\ndescription: ${description}\n---\nBody of ${name}\n`);
  writeFileSync(join(dir, name, "helper.txt"), "extra file");
};

describe("finding skills", () => {
  it("reads the skills of a root and of the newest version of each installed plugin", () => {
    const root = mkdtempSync(join(tmpdir(), "friend-skills-"));
    skill(join(root, "skills"), "my-style", "My own way");
    skill(join(root, "plugins", "cache", "market", "superpowers", "6.4.1", "skills"), "brainstorming", "old");
    skill(join(root, "plugins", "cache", "market", "superpowers", "6.10.0", "skills"), "brainstorming", "Use before any creative work");
    skill(join(root, "plugins", "cache", "market", "superpowers", "6.10.0", "skills"), "test-driven-development", "Use when implementing");
    mkdirSync(join(root, "skills", "not-a-skill"), { recursive: true });
    const found = discoverSkills([root]);
    expect(found.map((s) => s.id)).toEqual(["my-style", "superpowers:brainstorming", "superpowers:test-driven-development"]);
    expect(found.find((s) => s.id === "superpowers:brainstorming")!.description).toBe("Use before any creative work"); // 6.10.0 is newer than 6.4.1
  });

  it("finds nothing in a folder that is not there, and the owner's folders replace Claude Code's own", () => {
    expect(discoverSkills(["C:/definitely/not/here"])).toEqual([]);
    expect(skillRootsOf(["D:/mine"], {}, "C:/home")).toEqual(["D:/mine"]);
    expect(skillRootsOf([], { CLAUDE_CONFIG_DIR: "D:/cfg" }, "C:/home")).toEqual(["D:/cfg"]);
    expect(skillRootsOf([], {}, "C:/home")[0]!.replace(/\\/g, "/")).toBe("C:/home/.claude");
  });
});

describe("what a worker is given", () => {
  it("is a plugin folder with just the chosen skills, whole, made new each time", () => {
    const root = mkdtempSync(join(tmpdir(), "friend-skills-"));
    skill(join(root, "skills"), "a-skill", "A");
    skill(join(root, "skills"), "b-skill", "B");
    const all = discoverSkills([root]);
    const dest = join(root, "w.skills");
    buildSkillPlugin(dest, all);
    expect(JSON.parse(readFileSync(join(dest, ".claude-plugin", "plugin.json"), "utf8")).name).toBe("office-skills");
    expect(readFileSync(join(dest, "skills", "a-skill", "SKILL.md"), "utf8")).toMatch(/Body of a-skill/);
    expect(existsSync(join(dest, "skills", "a-skill", "helper.txt"))).toBe(true);
    buildSkillPlugin(dest, all.filter((s) => s.id === "b-skill"));
    expect(existsSync(join(dest, "skills", "a-skill"))).toBe(false);
    expect(existsSync(join(dest, "skills", "b-skill", "SKILL.md"))).toBe(true);
  });

  it("writes a connector the way Claude Code reads it", () => {
    expect(mcpEntry({ id: "f", name: "F", kind: "stdio", command: "node", args: ["s.js"], env: { K: "v" }, enabled: true })).toEqual({ command: "node", args: ["s.js"], env: { K: "v" } });
    expect(mcpEntry({ id: "h", name: "H", kind: "http", url: "https://x.example/mcp", headers: { A: "b" }, enabled: true })).toEqual({ type: "http", url: "https://x.example/mcp", headers: { A: "b" } });
  });
});

describe("allow lists and tool names", () => {
  it("allows exactly, by a trailing star, or everything with a lone star; and an empty list nothing", () => {
    expect(matchesAllow(["a"], "a")).toBe(true);
    expect(matchesAllow(["a"], "b")).toBe(false);
    expect(matchesAllow(["superpowers:*"], "superpowers:brainstorming")).toBe(true);
    expect(matchesAllow(["superpowers:*"], "other:x")).toBe(false);
    expect(matchesAllow(["*"], "anything")).toBe(true);
    expect(matchesAllow([], "a")).toBe(false);
  });
  it("tells the server of a tool, with the name written the way Claude Code writes it", () => {
    expect(toolServer("mcp__files__read")).toBe("files");
    expect(toolServer("Bash")).toBeNull();
    expect(normServer("my-files.v2")).toBe("my_files_v2");
  });
});
