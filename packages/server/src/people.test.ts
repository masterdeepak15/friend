import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb, type Db } from "./db";
import { MAX_FACES_PER_PERSON, MAX_PEOPLE, People } from "./people";
import { sealText, unsealText } from "./secretBox";

const DIM = 128;
/** A made-up face: a repeatable list of 128 numbers. Two with the same seed are the same face. */
function face(seed: number): number[] {
  let s = seed * 9301 + 49297;
  return Array.from({ length: DIM }, () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280 - 0.5;
  });
}
const wobble = (v: number[], amount: number, seed = 7) => v.map((x, i) => x + Math.sin(i * seed) * amount);

let dir: string;
let db: Db;
let people: People;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "friend-people-"));
  db = openDb(dir);
  people = new People(db, dir);
});

describe("sealText", () => {
  it("round-trips and refuses a different key", () => {
    const sealed = sealText("hello", dir);
    expect(sealed.startsWith("enc:v1:")).toBe(true);
    expect(unsealText(sealed, dir)).toBe("hello");
    expect(unsealText(sealed, mkdtempSync(join(tmpdir(), "friend-people-other-")))).toBeNull();
    expect(unsealText("not sealed", dir)).toBeNull();
  });
});

describe("People", () => {
  it("introduces someone and lists them without any face numbers", () => {
    people.introduce({ name: "Priya", relation: "sister", embedding: face(1) });
    const list = people.list();
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ name: "Priya", relation: "sister", usable: true });
    expect(JSON.stringify(list)).not.toMatch(/embedding|vec/);
  });

  it("keeps the face numbers encrypted in the database", () => {
    const v = face(1);
    people.introduce({ name: "Priya", embedding: v });
    const raw = (db.prepare("select vec from person_faces").get() as { vec: string }).vec;
    expect(raw.startsWith("enc:v1:")).toBe(true);
    const plain = Buffer.from(new Float32Array(v).buffer).toString("base64");
    expect(raw).not.toContain(plain);
    expect(raw).not.toContain(String(v[0]));
  });

  it("recognises the same face again, and says nothing for a stranger", () => {
    const v = face(1);
    people.introduce({ name: "Priya", relation: "sister", embedding: v });
    people.introduce({ name: "Dev", relation: "friend", embedding: face(2) });
    const [a, b, c] = people.match([wobble(v, 0.02), face(3), wobble(face(2), 0.02, 3)]);
    expect(a).toMatchObject({ name: "Priya", relation: "sister" });
    expect(b).toBeNull();
    expect(c).toMatchObject({ name: "Dev" });
    expect(a!.score).toBeGreaterThan(0.55);
  });

  it("never stores a face it does not know", () => {
    people.introduce({ name: "Priya", embedding: face(1) });
    people.match([face(9), face(10)]);
    expect((db.prepare("select count(*) as c from person_faces").get() as { c: number }).c).toBe(1);
  });

  it("adds another face to the same person when introduced again, up to a limit", () => {
    for (let i = 0; i < MAX_FACES_PER_PERSON; i++) people.introduce({ name: "Priya", embedding: wobble(face(1), 0.1, i + 1) });
    expect(people.list()).toHaveLength(1);
    expect(() => people.introduce({ name: "priya", embedding: face(1) })).toThrow(/enough pictures/i);
  });

  it("refuses numbers that cannot be a face", () => {
    expect(() => people.introduce({ name: "Priya", embedding: [1, 2, 3] })).toThrow(/face/i);
    expect(() => people.introduce({ name: "Priya", embedding: Array(DIM).fill(NaN) })).toThrow(/face/i);
  });

  it("cleans names and refuses empty or long ones", () => {
    people.introduce({ name: "  Pri\u0000ya\n ", embedding: face(1) });
    expect(people.list()[0]!.name).toBe("Pri ya");
    expect(() => people.introduce({ name: "   ", embedding: face(2) })).toThrow(/name/i);
    expect(() => people.introduce({ name: "x".repeat(41), embedding: face(2) })).toThrow(/name/i);
  });

  it(`stops at ${MAX_PEOPLE} people with a plain message`, () => {
    for (let i = 0; i < MAX_PEOPLE; i++) people.introduce({ name: `Person ${i}`, embedding: face(i + 1) });
    expect(() => people.introduce({ name: "One more", embedding: face(999) })).toThrow(/50 people/);
  });

  it("removes one person with their face numbers", () => {
    const id = people.introduce({ name: "Priya", embedding: face(1) }).id;
    people.introduce({ name: "Dev", embedding: face(2) });
    people.remove(id);
    expect(people.list().map((p) => p.name)).toEqual(["Dev"]);
    expect((db.prepare("select count(*) as c from person_faces").get() as { c: number }).c).toBe(1);
    expect(people.match([face(1)])[0]).toBeNull();
  });

  it("forgets everyone", () => {
    people.introduce({ name: "Priya", embedding: face(1) });
    people.introduce({ name: "Dev", embedding: face(2) });
    people.forgetAll();
    expect(people.list()).toEqual([]);
    expect((db.prepare("select count(*) as c from person_faces").get() as { c: number }).c).toBe(0);
  });

  it("lists a person whose numbers cannot be read (the key was lost) as needing a new introduction, and does not crash", () => {
    people.introduce({ name: "Priya", embedding: face(1) });
    const other = new People(db, mkdtempSync(join(tmpdir(), "friend-people-other-")));
    expect(other.list()[0]).toMatchObject({ name: "Priya", usable: false });
    expect(other.match([face(1)])[0]).toBeNull();
  });

  it("finds a person by name for the tools, ignoring case", () => {
    const id = people.introduce({ name: "Priya", embedding: face(1) }).id;
    expect(people.find("priya")).toMatchObject({ id, name: "Priya" });
    expect(people.find("nobody")).toBeNull();
  });
});
