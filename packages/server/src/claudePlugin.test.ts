import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { parseSkillFile, readClaudePlugin, readMarketplace, type TextReader } from "./claudePlugin";
import { MAX_SKILL_BYTES } from "./plugins";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => readFileSync(join(here, "testing", "lemo-opuscar", n), "utf8");
const repo = { owner: "o", repo: "r" };

/** A repository held in memory. */
function fake(files: Record<string, string>): TextReader {
  return {
    tree: async () => ({ commit: "c".repeat(40), files: Object.entries(files).map(([path, t]) => ({ path, size: Buffer.byteLength(t) })) }),
    file: async (_r, path) => {
      if (files[path] === undefined) throw new Error(`no ${path}`);
      return files[path]!;
    },
  };
}

describe("readMarketplace", () => {
  it("reads the real lemo-opuscar marketplace", () => {
    const m = readMarketplace(fixture("marketplace.json"));
    expect(m.name).toBe("lemolab");
    expect(m.plugins).toEqual([{ name: "lemo-opuscar", source: "./plugin", description: expect.stringContaining("Make a film") }]);
  });
  it("says plainly when the file is not a marketplace", () => {
    expect(() => readMarketplace("not json")).toThrow(/not a marketplace/i);
    expect(() => readMarketplace('{"name":"x"}')).toThrow(/not a marketplace/i);
  });
  it("skips plugins whose source is not a folder of the same repository", () => {
    const m = readMarketplace(JSON.stringify({ name: "m", plugins: [{ name: "a", source: "./a" }, { name: "b", source: { source: "github", repo: "x/y" } }] }));
    expect(m.plugins.map((p) => p.name)).toEqual(["a"]);
  });
});

describe("parseSkillFile", () => {
  it("reads name and description from the frontmatter, quoted or not, and returns the body", () => {
    const s = parseSkillFile('---\nname: "My Skill"\ndescription: Does a thing.\nallowed-tools: x\n---\n\n# Body\ntext')!;
    expect(s).toMatchObject({ name: "My Skill", description: "Does a thing." });
    expect(s.body).toBe("# Body\ntext");
  });
  it("has no frontmatter: the body is everything and name and description are empty", () => {
    expect(parseSkillFile("# Title\nhello")).toMatchObject({ name: "", description: "", body: "# Title\nhello" });
  });
  it("returns null for an empty file", () => {
    expect(parseSkillFile("  \n")).toBeNull();
  });
});

describe("readClaudePlugin", () => {
  it("imports the real lemo-opuscar skill, leaves out its script and warns about it", async () => {
    const r = await readClaudePlugin(
      fake({ "plugin/.claude-plugin/plugin.json": fixture("plugin.json"), "plugin/skills/lemo-opuscar/SKILL.md": fixture("SKILL.md"), "plugin/skills/lemo-opuscar/scripts/setup.sh": "echo hi" }),
      repo,
      "./plugin",
    );
    expect(r.spec).toMatchObject({ id: "lemo-opuscar", name: "lemo-opuscar", skills: [{ name: "lemo-opuscar", description: expect.stringContaining("short film") }] });
    expect(r.spec.skills![0]!.text).toContain("Get the library");
    expect(r.spec.skills![0]!.text).not.toContain("allowed-tools");
    expect(r.leftOut).toContainEqual({ path: "plugin/skills/lemo-opuscar/scripts", why: expect.stringMatching(/script/i) });
    expect(r.warnings.join("\n")).toMatch(/lemo-opuscar.*scripts\/setup\.sh|skill base directory/i);
  });

  it("imports commands and agents as skills named cmd-… and agent-…", async () => {
    const r = await readClaudePlugin(
      fake({
        "skills/a/SKILL.md": "---\nname: a\ndescription: A.\n---\nA text",
        "commands/Deploy It.md": "---\ndescription: Deploys.\n---\nRun the deploy checklist.",
        "agents/reviewer.md": "---\nname: reviewer\ndescription: Reviews code.\n---\nYou review.",
      }),
      repo,
      "",
    );
    expect(r.spec.skills!.map((s) => s.name).sort()).toEqual(["a", "agent-reviewer", "cmd-deploy-it"]);
    expect(r.spec.skills!.find((s) => s.name === "cmd-deploy-it")!.description).toBe("Deploys.");
  });

  it("leaves out hooks, MCP servers and scripts with a reason", async () => {
    const r = await readClaudePlugin(fake({ "skills/a/SKILL.md": "---\nname: a\ndescription: A.\n---\nx", "hooks/hooks.json": "{}", ".mcp.json": "{}", "scripts/run.sh": "x" }), repo, "");
    expect(r.leftOut.map((l) => l.path).sort()).toEqual([".mcp.json", "hooks", "scripts"]);
    expect(r.leftOut.find((l) => l.path === "hooks")!.why).toMatch(/never installed/i);
    expect(r.leftOut.find((l) => l.path === ".mcp.json")!.why).toMatch(/connector/i);
  });

  it("leaves out a skill over the size limit, naming its size", async () => {
    const big = "---\nname: big\ndescription: Big.\n---\n" + "x".repeat(MAX_SKILL_BYTES + 100);
    const r = await readClaudePlugin(fake({ "skills/big/SKILL.md": big, "skills/ok/SKILL.md": "---\nname: ok\ndescription: Ok.\n---\nfine" }), repo, "");
    expect(r.spec.skills!.map((s) => s.name)).toEqual(["ok"]);
    expect(r.leftOut).toContainEqual({ path: "skills/big/SKILL.md", why: expect.stringMatching(/too large \(\d+ KB, limit 20\)/) });
  });

  it("keeps ten skills at most and says so", async () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 12; i++) files[`skills/s${i}/SKILL.md`] = `---\nname: s${i}\ndescription: D.\n---\nt`;
    const r = await readClaudePlugin(fake(files), repo, "");
    expect(r.spec.skills).toHaveLength(10);
    expect(r.warnings.join(" ")).toMatch(/10 skills/);
  });

  it("warns about tools and installs the text asks for", async () => {
    const r = await readClaudePlugin(fake({ "skills/a/SKILL.md": "---\nname: a\ndescription: A.\n---\nRun ffmpeg then npm install and read references/guide.md" }), repo, "");
    const w = r.warnings.join("\n");
    expect(w).toMatch(/ffmpeg/);
    expect(w).toMatch(/npm install/);
    expect(w).toMatch(/references\/guide\.md/);
  });

  it("makes names valid and unique", async () => {
    const r = await readClaudePlugin(
      fake({ "skills/x/SKILL.md": "---\nname: My Skill!\ndescription: A.\n---\n1", "skills/y/SKILL.md": "---\nname: my skill\ndescription: B.\n---\n2" }),
      repo,
      "",
    );
    expect(r.spec.skills!.map((s) => s.name)).toEqual(["my-skill", "my-skill-2"]);
  });

  it("says plainly when there is nothing to import", async () => {
    const r = await readClaudePlugin(fake({ "README.md": "hello" }), repo, "");
    expect(r.spec.skills).toEqual([]);
    expect(r.warnings.join(" ")).toMatch(/no skills, commands or agents/i);
  });
});
