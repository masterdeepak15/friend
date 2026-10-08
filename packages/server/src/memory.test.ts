import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db";
import { MAX_MEMORIES, MAX_MEMORY_CHARS, Memory } from "./memory";

let mem: Memory;
let now = 1_000;
beforeEach(() => {
  now = 1_000;
  mem = new Memory(openDb(mkdtempSync(join(tmpdir(), "friend-mem-"))), () => now++);
});

describe("Memory", () => {
  it("stores a note and lists it newest first", () => {
    const a = mem.add("My sister is Priya", "owner");
    const b = mem.add("The NAS is at 192.168.1.20", "agent");
    expect(a).toMatchObject({ ok: true, duplicate: false });
    expect(mem.list().map((m) => m.text)).toEqual(["The NAS is at 192.168.1.20", "My sister is Priya"]);
    expect(mem.list()[0]).toMatchObject({ source: "agent" });
    expect(b.ok && b.id).toBeGreaterThan(a.ok ? a.id : 0);
  });

  it("tidies whitespace and refuses empty notes", () => {
    mem.add("  lots   of\n\tspace  ", "owner");
    expect(mem.list()[0]!.text).toBe("lots of space");
    expect(mem.add("   \n ", "owner")).toEqual({ ok: false, error: "There is nothing to remember." });
  });

  it("does not store the same note twice, ignoring case", () => {
    const first = mem.add("Coffee is black", "owner");
    const again = mem.add("coffee IS black", "agent");
    expect(again).toEqual({ ok: true, id: first.ok ? first.id : -1, duplicate: true });
    expect(mem.count()).toBe(1);
  });

  it("refuses a note over the length limit", () => {
    const r = mem.add("x".repeat(MAX_MEMORY_CHARS + 1), "owner");
    expect(r).toEqual({ ok: false, error: `That note is too long (the limit is ${MAX_MEMORY_CHARS} characters).` });
    expect(mem.add("x".repeat(MAX_MEMORY_CHARS), "owner").ok).toBe(true);
  });

  it("refuses to forget things silently when full", () => {
    for (let i = 0; i < MAX_MEMORIES; i++) mem.add(`note ${i}`, "owner");
    const r = mem.add("one too many", "agent");
    expect(r).toEqual({ ok: false, error: "Memory is full. Forget something first." });
    expect(mem.count()).toBe(MAX_MEMORIES);
  });

  it("recent returns the newest notes up to the limit", () => {
    for (let i = 0; i < 30; i++) mem.add(`note ${i}`, "owner");
    const recent = mem.recent(20);
    expect(recent).toHaveLength(20);
    expect(recent[0]!.text).toBe("note 29");
  });

  it("search needs every word, ignores case, and returns newest first", () => {
    mem.add("Priya likes green tea", "owner");
    mem.add("The garage code is not stored here", "owner");
    mem.add("Priya's birthday is in May", "owner");
    expect(mem.search("priya").map((m) => m.text)).toEqual(["Priya's birthday is in May", "Priya likes green tea"]);
    expect(mem.search("PRIYA tea").map((m) => m.text)).toEqual(["Priya likes green tea"]);
    expect(mem.search("priya garage")).toEqual([]);
    expect(mem.search("   ")).toEqual([]);
  });

  it("search treats % and _ as plain characters and limits results", () => {
    mem.add("100% sure about this", "owner");
    mem.add("another note", "owner");
    expect(mem.search("100%").map((m) => m.text)).toEqual(["100% sure about this"]);
    expect(mem.search("_").length).toBe(0);
    for (let i = 0; i < 15; i++) mem.add(`tea ${i}`, "owner");
    expect(mem.search("tea")).toHaveLength(10);
  });

  it("forgets one note by id, and says whether it existed", () => {
    const r = mem.add("temporary", "owner");
    const id = r.ok ? r.id : -1;
    expect(mem.forget(id)).toBe(true);
    expect(mem.forget(id)).toBe(false);
    expect(mem.count()).toBe(0);
  });

  it("clear removes everything and reports how many", () => {
    mem.add("a", "owner");
    mem.add("b", "owner");
    expect(mem.clear()).toBe(2);
    expect(mem.count()).toBe(0);
  });
});
