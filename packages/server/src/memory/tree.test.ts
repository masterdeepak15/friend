import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CROWDED, MemoryTree, cleanPath } from "./tree";

const NOW = Date.UTC(2026, 9, 24, 12, 0);
const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "friend-tree-"));
  return { dir, tree: new MemoryTree(join(dir, "memory"), () => NOW) };
};
const ok = <T extends { ok: boolean }>(r: T) => {
  if (!r.ok) throw new Error((r as unknown as { error: string }).error);
  return r as Extract<T, { ok: true }>;
};

describe("paths", () => {
  it("take lowercase names of letters, digits and dashes, and nothing that could leave the tree", () => {
    expect(cleanPath("people/priya.md")).toMatchObject({ ok: true, parts: ["people", "priya.md"], isNote: true });
    expect(cleanPath("memory/people/")).toMatchObject({ ok: true, parts: ["people"], isNote: false });
    expect(cleanPath("")).toMatchObject({ ok: true, parts: [] });
    for (const bad of ["../x.md", "a/../b.md", "C:/x.md", "People/x.md", "a b/x.md", "x/.hidden.md", "a/b/c/d/e/f/g.md", "x.txt", 5, null]) {
      expect(cleanPath(bad as never).ok, String(bad)).toBe(false);
    }
  });
});

describe("a tree nobody has shaped yet", () => {
  it("starts as one root index with nothing in it, and fixes no branch names", () => {
    const { tree } = fresh();
    const idx = tree.rootIndex();
    expect(idx).toMatch(/^# Memory/);
    expect(idx).not.toMatch(/\]\(/);
    expect(tree.count()).toBe(0);
  });

  it("grows any branch the assistant names, at any depth, and every folder is listed from the root down", () => {
    const { tree } = fresh();
    ok(tree.write("family/sister/priya.md", "Priya is the owner's younger sister. Lives in Pune.", { title: "Priya", summary: "younger sister, Pune" }));
    ok(tree.write("projects/friend/memory-design.md", "Memory is a tree of small notes."));
    expect(tree.rootIndex()).toMatch(/- \[Family\]\(family\/\)/);
    expect(tree.rootIndex()).toMatch(/- \[Projects\]\(projects\/\)/);
    expect(ok(tree.read("family")).text).toMatch(/- \[Sister\]\(sister\/\)/);
    expect(ok(tree.read("family/sister")).text).toMatch(/- \[Priya\]\(priya\.md\) — younger sister, Pune/);
    expect(ok(tree.read("family/sister/priya.md"))).toMatchObject({ kind: "note", text: expect.stringContaining("younger sister") });
    expect(tree.check()).toEqual([]);
  });

  it("updates a note in place: one index line, the title and summary kept unless new ones are given", () => {
    const { tree } = fresh();
    ok(tree.write("a/n.md", "first", { title: "Nice title", summary: "the gist" }));
    ok(tree.write("a/n.md", "second text"));
    const idx = ok(tree.read("a")).text;
    expect(idx.match(/\(n\.md\)/g)).toHaveLength(1);
    expect(idx).toMatch(/\[Nice title\]\(n\.md\) — the gist/);
    expect(ok(tree.read("a/n.md")).text).toMatch(/second text/);
    expect(ok(tree.read("a/n.md")).text).toMatch(/updated: 2026-10-24/);
  });

  it("takes a summary for the folder itself, shown beside it in its parent", () => {
    const { tree } = fresh();
    ok(tree.write("trading/limits.md", "Max loss 500 a trade.", { folderSummary: "the owner's trading rules and lessons" }));
    expect(tree.rootIndex()).toMatch(/\[Trading\]\(trading\/\) — the owner's trading rules and lessons/);
  });
});

describe("finding things", () => {
  it("searches titles, summaries and text, best title match first, and gives paths to read", () => {
    const { tree } = fresh();
    ok(tree.write("people/priya.md", "Likes tea.", { title: "Priya", summary: "sister" }));
    ok(tree.write("food/likes.md", "Priya prefers tea to coffee.", { title: "Food likes", summary: "drinks" }));
    const found = tree.search("priya tea");
    expect(found.map((f) => f.path)).toEqual(["people/priya.md", "food/likes.md"]);
    expect(tree.search("zzzz")).toEqual([]);
    expect(tree.search("   ")).toEqual([]);
  });

  it("reads a missing note or folder as a plain error", () => {
    const { tree } = fresh();
    expect(tree.read("nope.md")).toMatchObject({ ok: false, error: expect.stringMatching(/no note/) });
    expect(tree.read("nope")).toMatchObject({ ok: false, error: expect.stringMatching(/no folder/) });
  });
});

describe("tidying", () => {
  it("removes a note and its line, and a folder with everything in it and its line", () => {
    const { tree } = fresh();
    ok(tree.write("a/x.md", "x"));
    ok(tree.write("a/y.md", "y"));
    ok(tree.write("b/z.md", "z"));
    expect(ok(tree.remove("a/x.md")).removed).toBe(1);
    expect(ok(tree.read("a")).text).not.toMatch(/\(x\.md\)/);
    expect(ok(tree.remove("b")).removed).toBe(1);
    expect(tree.rootIndex()).not.toMatch(/\(b\/\)/);
    expect(tree.remove("")).toMatchObject({ ok: false });
    expect(tree.check()).toEqual([]);
  });

  it("moves a note and a folder, and both indexes follow", () => {
    const { tree } = fresh();
    ok(tree.write("inbox/idea.md", "Build X.", { title: "Idea X", summary: "an idea" }));
    ok(tree.move("inbox/idea.md", "projects/x/idea.md"));
    expect(ok(tree.read("inbox")).text).not.toMatch(/\(idea\.md\)/);
    expect(ok(tree.read("projects/x")).text).toMatch(/\[Idea X\]\(idea\.md\) — an idea/);
    ok(tree.move("projects/x", "work/x"));
    expect(tree.rootIndex()).toMatch(/\(work\/\)/);
    expect(tree.rootIndex()).not.toMatch(/\(projects\/\)\) —/);
    expect(ok(tree.read("work/x/idea.md")).text).toMatch(/Build X/);
    expect(tree.check()).toEqual([]);
    expect(tree.move("work/x", "work/x/inner")).toMatchObject({ ok: false });
    expect(tree.move("work/x/idea.md", "work/x/idea.md")).toMatchObject({ ok: false });
    expect(tree.move("work/x", "other.md")).toMatchObject({ ok: false });
  });
});

describe("keeping everything findable from the root", () => {
  it("lists a note the owner dropped in by hand, drops a dead link, and makes a missing index, all without losing the owner's text", () => {
    const { dir, tree } = fresh();
    ok(tree.write("home/lights.md", "Hue bridge at the hall."));
    writeFileSync(join(dir, "memory", "home", "wifi.md"), "# Wifi password hint\n\nIt is on the fridge.\n"); // no front matter, never listed
    mkdirSync(join(dir, "memory", "stray"));
    writeFileSync(join(dir, "memory", "stray", "a.md"), "A note in a folder nobody listed.");
    const idxPath = join(dir, "memory", "home", "INDEX.md");
    writeFileSync(idxPath, `${readFileSync(idxPath, "utf8")}\n- [Gone](gone.md) — deleted by hand\n`);
    const kinds = tree.check().map((p) => `${p.kind}:${p.path}`).sort();
    expect(kinds).toEqual(["dead-link:home/gone.md", "no-index:stray", "unlisted-folder:stray", "unlisted:home/wifi.md", "unlisted:stray/a.md"].sort());
    expect(tree.repair()).toBe(5);
    expect(tree.check()).toEqual([]);
    expect(ok(tree.read("home")).text).toMatch(/\[Wifi password hint\]\(wifi\.md\)/);
    expect(ok(tree.read("home")).text).not.toMatch(/\(gone\.md\)/);
    expect(tree.rootIndex()).toMatch(/\(stray\/\)/);
    expect(ok(tree.read("home/wifi.md")).text).toMatch(/on the fridge/);
  });

  it("keeps what a person wrote above the list in an index when it adds lines", () => {
    const { dir, tree } = fresh();
    ok(tree.write("a/one.md", "1"));
    const p = join(dir, "memory", "a", "INDEX.md");
    writeFileSync(p, `# A — my own heading\n\nRead this first: it is about A.\n${readFileSync(p, "utf8").split("\n").filter((l) => l.startsWith("- [")).join("\n")}\n`);
    ok(tree.write("a/two.md", "2"));
    const text = readFileSync(p, "utf8");
    expect(text).toMatch(/Read this first: it is about A\./);
    expect(text).toMatch(/\(one\.md\)/);
    expect(text).toMatch(/\(two\.md\)/);
  });
});

describe("limits", () => {
  it("refuses an empty or huge note, an INDEX.md write, and a name that is not allowed", () => {
    const { tree } = fresh();
    expect(tree.write("a/x.md", "   ")).toMatchObject({ ok: false });
    expect(tree.write("a/x.md", "x".repeat(6001))).toMatchObject({ ok: false, error: expect.stringMatching(/too long/) });
    expect(tree.write("a/INDEX.md", "hack")).toMatchObject({ ok: false });
    expect(tree.write("../escape.md", "x")).toMatchObject({ ok: false });
    expect(tree.write("a/x", "x")).toMatchObject({ ok: false });
  });

  it("tells the writer when a note is long, and when a folder is crowded and should be grouped", () => {
    const { tree } = fresh();
    expect(ok(tree.write("a/long.md", "word ".repeat(300))).hint).toMatch(/split/i);
    let last: { hint?: string } = {};
    for (let i = 0; i < CROWDED + 1; i++) last = ok(tree.write(`crowd/n${i}.md`, `note ${i}`));
    expect(last.hint).toMatch(/sub-folders/);
  });

  it("does not follow a link out of the tree", () => {
    const { dir, tree } = fresh();
    tree.ensure();
    const outside = join(dir, "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "secret.md"), "secret");
    try {
      symlinkSync(outside, join(dir, "memory", "link"), "junction");
    } catch {
      return; // this machine does not allow links: nothing to test
    }
    expect(tree.read("link/secret.md")).toMatchObject({ ok: false, error: expect.stringMatching(/link/) });
    expect(tree.write("link/new.md", "x")).toMatchObject({ ok: false });
    expect(tree.search("secret")).toEqual([]);
  });
});
