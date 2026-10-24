import { Audit, Auth, Memory, MemoryTree, openDb } from "@friend/server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { run, type IO } from "./cli";

const pin = "246810";
let dataDir: string;
let lines: string[];
const text = () => lines.join("\n");
const io = (answer = ""): IO => ({ dataDir, out: (s) => lines.push(s), err: (s) => lines.push(s), ask: async () => answer });

/** An owner with a PIN and three notes in this data dir. */
async function seed() {
  const db = openDb(dataDir);
  await new Auth(db, new Audit(db)).setupOwner({ password: "correct horse battery", pin, assistantName: "Jarvis" });
  const mem = new Memory(db);
  mem.add("My sister is Priya", "owner");
  mem.add("The NAS is at 192.168.1.20", "agent");
  mem.add("Coffee is black", "owner");
  return { mem, close: () => db.close() };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "friend-memcli-"));
  lines = [];
});

describe("friend memory", () => {
  it("lists notes newest first with their numbers and who saved them", async () => {
    const s = await seed();
    expect(await run(["memory", "list"], io())).toBe(0);
    s.close();
    const out = lines;
    expect(out[0]).toMatch(/#3.*Coffee is black.*owner/);
    expect(out[1]).toMatch(/#2.*The NAS is at 192\.168\.1\.20.*agent/);
    expect(out[2]).toMatch(/#1.*My sister is Priya/);
  });

  it("says so when there is nothing saved", async () => {
    expect(await run(["memory", "list"], io())).toBe(0);
    expect(text()).toMatch(/no notes/i);
  });

  it("forgets one note by number, and reports an unknown number", async () => {
    const s = await seed();
    expect(await run(["memory", "forget", "2"], io())).toBe(0);
    expect(s.mem.list().map((m) => m.id)).toEqual([3, 1]);
    expect(await run(["memory", "forget", "2"], io())).toBe(1);
    expect(text()).toMatch(/no note #2/i);
    expect(await run(["memory", "forget", "abc"], io())).toBe(1);
    expect(await run(["memory", "forget"], io())).toBe(1);
    s.close();
  });

  it("clear needs the right PIN", async () => {
    const s = await seed();
    expect(await run(["memory", "clear"], io("000000"))).toBe(1);
    expect(s.mem.count()).toBe(3);
    expect(text()).toMatch(/incorrect pin/i);
    lines = [];
    expect(await run(["memory", "clear"], io(pin))).toBe(0);
    expect(s.mem.count()).toBe(0);
    expect(text()).toMatch(/deleted 3 notes/i);
    s.close();
  });

  it("clear with nothing saved does not ask for the PIN", async () => {
    const asked = { ...io(), ask: async () => { throw new Error("must not ask"); } };
    expect(await run(["memory", "clear"], asked)).toBe(0);
    expect(text()).toMatch(/no notes/i);
  });

  it("rejects an unknown subcommand with usage", async () => {
    expect(await run(["memory", "dance"], io())).toBe(1);
    expect(text()).toMatch(/usage: friend memory/i);
  });
});

describe("friend memory with the memory tree", () => {
  const grow = () => {
    const tree = new MemoryTree(join(dataDir, "memory"));
    tree.write("family/priya.md", "Priya is the owner's sister.", { title: "Priya", summary: "sister", folderSummary: "family members" });
    tree.write("projects/friend/memory.md", "A tree of small notes.", { title: "Memory design" });
    return tree;
  };

  it("lists the whole tree from the root, folders and notes with their depth, and counts the notes", async () => {
    grow();
    expect(await run(["memory", "list"], io())).toBe(0);
    expect(lines).toContain("family/  Family — family members");
    expect(lines).toContain("  family/priya.md  Priya — sister");
    expect(lines).toContain("    projects/friend/memory.md  Memory design — A tree of small notes.");
    expect(lines.at(-1)).toMatch(/^2 notes\. Open one with: friend memory show <path>/);
  });

  it("shows a note or a folder's index, and says so when there is none", async () => {
    grow();
    expect(await run(["memory", "show", "family/priya.md"], io())).toBe(0);
    expect(text()).toMatch(/Priya is the owner's sister/);
    lines = [];
    expect(await run(["memory", "show", "projects"], io())).toBe(0);
    expect(text()).toMatch(/\(friend\/\)/);
    lines = [];
    expect(await run(["memory", "show", "nope.md"], io())).toBe(1);
    expect(text()).toMatch(/no note/i);
  });

  it("forgets a note or a whole folder by path, keeps the indexes right, and still forgets a flat note by number", async () => {
    const tree = grow();
    expect(await run(["memory", "forget", "family/priya.md"], io())).toBe(0);
    expect(text()).toMatch(/forgot 1 note/i);
    expect(tree.check()).toEqual([]);
    lines = [];
    expect(await run(["memory", "forget", "projects"], io())).toBe(0);
    expect(tree.count()).toBe(0);
    expect(tree.rootIndex()).not.toMatch(/projects/);
    lines = [];
    expect(await run(["memory", "forget", "7"], io())).toBe(1);
    expect(text()).toMatch(/no note #7/i);
  });

  it("clear needs the PIN and then empties the tree and the older list", async () => {
    const s = await seed();
    const tree = grow();
    expect(await run(["memory", "clear"], io("000000"))).toBe(1);
    expect(tree.count()).toBe(2);
    lines = [];
    expect(await run(["memory", "clear"], io(pin))).toBe(0);
    expect(text()).toMatch(/deleted 5 notes/i);
    expect(tree.count()).toBe(0);
    expect(s.mem.count()).toBe(0);
    expect(tree.rootIndex()).toMatch(/^# Memory/);
    s.close();
  });
});
