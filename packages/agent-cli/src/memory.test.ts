import { Audit, Auth, Memory, openDb } from "@friend/server";
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
