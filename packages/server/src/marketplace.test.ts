import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { TextReader } from "./claudePlugin";
import { GithubError } from "./github";
import { openDb } from "./db";
import { Market } from "./marketplace";
import { Plugins } from "./plugins";
import { authorPlugin } from "./author";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = (n: string) => readFileSync(join(here, "testing", "lemo-opuscar", n), "utf8");
const COMMIT = "abcdef0123456789abcdef0123456789abcdef01";

/** A repository in memory; every call to the factory is a fresh reader, like the real one. */
function repoOf(files: Record<string, string>, fail?: () => Error | null): () => TextReader {
  return () => ({
    tree: async () => {
      const e = fail?.();
      if (e) throw e;
      return { commit: COMMIT, files: Object.entries(files).map(([path, t]) => ({ path, size: Buffer.byteLength(t) })) };
    },
    file: async (_r, path) => {
      if (files[path] === undefined) throw new GithubError("missing", `no ${path}`);
      return files[path]!;
    },
  });
}

const LEMO = {
  "README.md": "# Lemo\nInstall the plugin from ./plugin.",
  "docs/guide.md": "the guide",
  ".claude-plugin/marketplace.json": fixture("marketplace.json"),
  "plugin/.claude-plugin/plugin.json": fixture("plugin.json"),
  "plugin/skills/lemo-opuscar/SKILL.md": fixture("SKILL.md"),
  "plugin/skills/lemo-opuscar/scripts/setup.sh": "echo hi",
};
const SIMPLE = {
  "README.md": "# Simple\nTwo skills.",
  "skills/a/SKILL.md": "---\nname: a\ndescription: Does A.\n---\nA full text",
  "skills/b/SKILL.md": "---\nname: b\ndescription: Does B.\n---\nB full text",
};

function setup(files: Record<string, string> = LEMO, opts: { fail?: () => Error | null } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "friend-market-"));
  const plugins = new Plugins(openDb(dir), join(dir, "plugins"));
  const audit: [string, string, Record<string, unknown>][] = [];
  const notes: { path: string; text: string; title: string }[] = [];
  let now = 1_000_000;
  const market = new Market({
    dir,
    reader: repoOf(files, opts.fail),
    plugins,
    memory: { write: (path, text, meta) => (notes.push({ path, text, title: meta.title }), true) },
    audit: { log: (a: string, w: string, d?: Record<string, unknown>) => void audit.push([a, w, d ?? {}]) } as never,
    clock: () => now,
  });
  return { dir, plugins, market, audit, notes, tick: (ms: number) => void (now += ms) };
}

describe("looking at a repository", () => {
  it("stages it and returns the README, the docs, the file list and what each plugin holds", async () => {
    const { market, audit } = setup();
    const f = await market.fetch("https://github.com/lemomo-ai/lemo-opuscar.git");
    expect(f.commit).toBe(COMMIT);
    expect(f.readme).toContain("Install the plugin");
    expect(f.docs.map((d) => d.path)).toContain("docs/guide.md");
    expect(f.tree).toContain("plugin/skills/lemo-opuscar/SKILL.md");
    expect(f.plugins).toHaveLength(1);
    expect(f.plugins[0]).toMatchObject({ id: "lemo-opuscar", skills: [{ name: "lemo-opuscar" }] });
    expect(f.plugins[0]!.leftOut.map((l) => l.path)).toContain("plugin/skills/lemo-opuscar/scripts");
    expect(audit.some(([, what, d]) => what === "plugins.fetch" && d.repo === "lemomo-ai/lemo-opuscar" && d.commit === COMMIT)).toBe(true);
  });

  it("finds skills in a repository that has no marketplace file", async () => {
    const { market } = setup(SIMPLE);
    const f = await market.fetch("o/simple");
    expect(f.plugins.map((p) => p.skills.map((s) => s.name))).toEqual([["a", "b"]]);
  });

  it("refuses a link that is not GitHub, in plain words", async () => {
    const { market } = setup();
    await expect(market.fetch("https://evil.example/o/r")).rejects.toThrow(/GitHub/);
  });

  it("passes on a reader failure and leaves nothing installed", async () => {
    const { market, plugins } = setup(LEMO, { fail: () => new GithubError("rate", "GitHub's limit is used up") });
    await expect(market.fetch("o/r")).rejects.toThrow(/limit is used up/);
    expect(plugins.list()).toEqual([]);
  });
});

describe("reading more", () => {
  it("reads a file the repository has, and no other", async () => {
    const { market } = setup();
    const { staging } = await market.fetch("o/r");
    expect(await market.read(staging, "docs/guide.md")).toBe("the guide");
    await expect(market.read(staging, "not/there.md")).rejects.toThrow(/not in the repository/i);
    await expect(market.read("nope", "docs/guide.md")).rejects.toThrow(/fetch it again/i);
  });

  it("forgets a look after fifteen minutes", async () => {
    const { market, tick } = setup();
    const { staging } = await market.fetch("o/r");
    tick(16 * 60_000);
    await expect(market.read(staging, "docs/guide.md")).rejects.toThrow(/fetch it again/i);
    await expect(market.import(staging)).rejects.toThrow(/fetch it again/i);
  });
});

describe("installing", () => {
  it("shows the source and the full text of what would be installed", async () => {
    const { market } = setup(SIMPLE);
    const { staging } = await market.fetch("o/simple");
    const text = market.preview(staging);
    expect(text).toContain("github.com/o/simple");
    expect(text).toContain(COMMIT.slice(0, 7));
    expect(text).toContain("A full text");
    expect(text).toContain("B full text");
    expect(market.preview(staging, { skills: ["b"] })).not.toContain("A full text");
  });

  it("installs the skills, switches them on, records where they came from, writes the note and audits it", async () => {
    const { market, plugins, notes, audit } = setup(SIMPLE);
    const { staging } = await market.fetch("o/simple");
    const r = await market.import(staging);
    expect(r).toEqual({ ids: ["simple"], skills: ["a", "b"] });
    expect(plugins.skills().map((s) => s.name)).toEqual(["a", "b"]);
    expect(plugins.skillText("simple", "a")).toBe("A full text");
    expect(plugins.list()[0]).toMatchObject({ id: "simple", enabled: true, source: `github.com/o/simple@${COMMIT.slice(0, 7)}` });
    expect(notes).toHaveLength(1);
    expect(notes[0]!.path).toBe("skills/simple.md");
    expect(notes[0]!.text).toMatch(/Does A\./);
    expect(notes[0]!.text).toContain("github.com/o/simple");
    expect(audit.some(([, what, d]) => what === "plugins.import" && JSON.stringify(d).includes("simple"))).toBe(true);
  });

  it("takes only the skills it is told to", async () => {
    const { market, plugins } = setup(SIMPLE);
    const { staging } = await market.fetch("o/simple");
    expect((await market.import(staging, { skills: ["b"] })).skills).toEqual(["b"]);
    expect(plugins.skills().map((s) => s.name)).toEqual(["b"]);
  });

  it("upgrades when it is imported again, instead of making a second copy", async () => {
    const { market, plugins } = setup(SIMPLE);
    await market.import((await market.fetch("o/simple")).staging);
    await market.import((await market.fetch("o/simple")).staging);
    expect(plugins.list()).toHaveLength(1);
    expect(plugins.list()[0]!.version).toBe("1.0.1");
  });

  it("will not replace a plugin that was not imported", async () => {
    const { market, plugins, dir } = setup(SIMPLE);
    authorPlugin(plugins, join(dir, "drafts"), { id: "simple", name: "Mine", skills: [{ name: "x", description: "d", text: "t" }] });
    await expect(market.import((await market.fetch("o/simple")).staging)).rejects.toThrow(/already installed.*not imported/i);
    expect(plugins.skillText("simple", "x")).toBe("t");
  });

  it("says plainly when there is nothing to install", async () => {
    const { market } = setup({ "README.md": "hello" });
    const { staging } = await market.fetch("o/empty");
    await expect(market.import(staging)).rejects.toThrow(/nothing to import/i);
  });

  it("leaves no draft folder behind", async () => {
    const { market, dir } = setup(SIMPLE);
    await market.import((await market.fetch("o/simple")).staging);
    expect(existsSync(join(dir, "drafts")) ? readdirSync(join(dir, "drafts")) : []).toEqual([]);
  });
});

describe("marketplaces", () => {
  it("adds one after checking its marketplace file, lists its plugins, and removes it", async () => {
    const { market } = setup();
    await market.addMarketplace("lemomo-ai/lemo-opuscar");
    const list = market.marketplaces();
    expect(list).toEqual([{ repo: "lemomo-ai/lemo-opuscar", name: "lemolab", plugins: [{ name: "lemo-opuscar", source: "./plugin", description: expect.stringContaining("film") }] }]);
    market.removeMarketplace("lemomo-ai/lemo-opuscar");
    expect(market.marketplaces()).toEqual([]);
  });

  it("refuses a repository without a marketplace file", async () => {
    const { market } = setup(SIMPLE);
    await expect(market.addMarketplace("o/simple")).rejects.toThrow(/no marketplace/i);
  });

  it("keeps at most ten, and does not list the same one twice", async () => {
    const { market } = setup();
    await market.addMarketplace("a/a");
    await market.addMarketplace("a/a");
    expect(market.marketplaces()).toHaveLength(1);
    for (let i = 0; i < 9; i++) await market.addMarketplace(`o/r${i}`);
    await expect(market.addMarketplace("o/one-more")).rejects.toThrow(/ten/i);
  });

  it("survives a restart", async () => {
    const a = setup();
    await a.market.addMarketplace("lemomo-ai/lemo-opuscar");
    const again = new Market({ dir: a.dir, reader: repoOf(LEMO), plugins: a.plugins, audit: { log() {} } as never });
    expect(again.marketplaces().map((m) => m.repo)).toEqual(["lemomo-ai/lemo-opuscar"]);
  });
});
