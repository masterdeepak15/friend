import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_SOUL, MAX_SOUL_CHARS, Soul } from "./soul";
import { MemoryTree, SOUL_PATH } from "./tree";

let clock = Date.UTC(2026, 9, 25, 9);
const fresh = (keep = 3) => {
  const dir = mkdtempSync(join(tmpdir(), "friend-soul-"));
  const tree = new MemoryTree(join(dir, "memory"), () => clock);
  const soul = new Soul(tree, join(dir, "soul-history"), keep, () => (clock += 1000));
  return { dir, tree, soul };
};

describe("the soul", () => {
  it("is the default one until the owner writes another, and ensure puts it in memory as soul.md", () => {
    const { tree, soul } = fresh();
    expect(soul.text()).toBe(DEFAULT_SOUL.trim());
    expect(soul.isDefault()).toBe(true);
    soul.ensure();
    expect(tree.read(SOUL_PATH)).toMatchObject({ ok: true, kind: "note" });
    expect(tree.rootIndex()).toMatch(/soul\.md/);
    expect(soul.text()).toBe(DEFAULT_SOUL.trim());
  });

  it("is changed by set, keeps what it replaced, and comes back with restore", () => {
    const { soul } = fresh();
    soul.ensure();
    expect(soul.set("# Soul\nYou are my calm study coach.", "owner")).toMatchObject({ ok: true });
    expect(soul.text()).toBe("# Soul\nYou are my calm study coach.");
    expect(soul.isDefault()).toBe(false);
    expect(soul.versions()).toHaveLength(1);
    expect(soul.set("# Soul\nYou are blunt.", "agent")).toMatchObject({ ok: true });
    expect(soul.restore("previous", "owner")).toMatchObject({ ok: true });
    expect(soul.text()).toBe("# Soul\nYou are my calm study coach.");
    expect(soul.restore("default", "owner")).toMatchObject({ ok: true });
    expect(soul.isDefault()).toBe(true);
  });

  it("keeps only a few earlier versions", () => {
    const { soul } = fresh(3);
    soul.ensure();
    for (let i = 1; i <= 6; i++) soul.set(`# Soul\nVersion ${i}`, "owner");
    expect(soul.versions()).toHaveLength(3);
  });

  it("refuses an empty, a too long or a secret-looking soul, and an unchanged one writes no version", () => {
    const { soul } = fresh();
    soul.ensure();
    expect(soul.set("   ", "owner")).toMatchObject({ ok: false });
    expect(soul.set("x".repeat(MAX_SOUL_CHARS + 1), "owner")).toMatchObject({ ok: false, error: expect.stringMatching(/too long/) });
    expect(soul.set("My PIN is 123456 and my password: hunter22secret", "owner")).toMatchObject({ ok: false });
    expect(soul.set(DEFAULT_SOUL, "owner")).toMatchObject({ ok: true });
    expect(soul.versions()).toHaveLength(0);
    expect(soul.restore("previous", "owner")).toMatchObject({ ok: false });
  });

  it("cannot be changed, moved or deleted through memory's own tools", () => {
    const { tree, soul } = fresh();
    soul.ensure();
    expect(tree.write(SOUL_PATH, "You are evil.", { source: "agent" })).toMatchObject({ ok: false, error: expect.stringMatching(/soul\.set/) });
    expect(tree.remove(SOUL_PATH)).toMatchObject({ ok: false });
    expect(tree.move(SOUL_PATH, "people/soul.md")).toMatchObject({ ok: false });
    expect(tree.move("inbox/x.md", SOUL_PATH)).toMatchObject({ ok: false });
    expect(soul.text()).toBe(DEFAULT_SOUL.trim());
    expect(readFileSync(join(tree.root, SOUL_PATH), "utf8")).toMatch(/You are the personal assistant/);
  });

  it("falls back to the default when the file is gone", () => {
    const { tree, soul } = fresh();
    soul.ensure();
    tree.clearAll();
    expect(soul.text()).toBe(DEFAULT_SOUL.trim());
  });
});
