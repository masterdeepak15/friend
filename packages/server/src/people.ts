import { FACE_SIMILARITY_THRESHOLD } from "@friend/protocol";
import { createHash } from "node:crypto";
import type { Db } from "./db";
import { sealText, unsealText } from "./secretBox";

export const MAX_PEOPLE = 50;
export const MAX_FACES_PER_PERSON = 5;
const DIM = 128;

export interface PersonView {
  id: number;
  name: string;
  relation: string;
  addedAt: number;
  /** False when the saved face numbers cannot be read (the key was lost): the person must be introduced again. */
  usable: boolean;
}
export interface Match {
  id: number;
  name: string;
  relation: string;
  score: number;
}

/** Where the note about a person is kept in the memory tree. */
export function personNotePath(name: string): string {
  const slug = name.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  return `people/${slug || `person-${createHash("sha1").update(name).digest("hex").slice(0, 8)}`}.md`;
}

const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

function cosine(a: ArrayLike<number>, b: ArrayLike<number>): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return dot / (Math.sqrt(na) * Math.sqrt(nb) || 1);
}

/**
 * The people the owner has introduced. A face is kept only as 128 numbers, encrypted like the owner's keys, never as a picture, and
 * only for someone the owner named. Faces nobody introduced are never stored. Matching is a hint for the assistant and approves nothing.
 */
export class People {
  private cache = new Map<number, Float32Array | null>();

  constructor(
    private db: Db,
    private dataDir: string,
    private clock: () => number = Date.now,
  ) {}

  private vector(id: number, sealed: string): Float32Array | null {
    if (this.cache.has(id)) return this.cache.get(id)!;
    const text = unsealText(sealed, this.dataDir);
    let v: Float32Array | null = null;
    if (text !== null) {
      const bytes = Buffer.from(text, "base64");
      if (bytes.length === DIM * 4) v = new Float32Array(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length));
    }
    this.cache.set(id, v);
    return v;
  }

  introduce(a: { name: string; relation?: string; note?: string; embedding: number[] }): { id: number } {
    const name = clean(a.name, 80);
    if (!name || name.length > 40) throw new Error("The name must be 1 to 40 characters.");
    if (a.embedding.length !== DIM || a.embedding.some((x) => typeof x !== "number" || !Number.isFinite(x))) throw new Error("That is not a face I can remember.");
    const existing = this.find(name);
    let id: number;
    if (existing) {
      id = existing.id;
      const n = (this.db.prepare("select count(*) as c from person_faces where person_id = ?").get(id) as { c: number }).c;
      if (n >= MAX_FACES_PER_PERSON) throw new Error(`I already have enough pictures of ${existing.name}. Remove them first to start again.`);
    } else {
      const count = (this.db.prepare("select count(*) as c from people").get() as { c: number }).c;
      if (count >= MAX_PEOPLE) throw new Error(`I can remember at most ${MAX_PEOPLE} people. Remove someone first.`);
      id = Number(
        this.db
          .prepare("insert into people (name, relation, note, created_at) values (?, ?, ?, ?)")
          .run(name, clean(a.relation ?? "", 40), clean(a.note ?? "", 200), this.clock()).lastInsertRowid,
      );
    }
    this.db.prepare("insert into person_faces (person_id, vec, created_at) values (?, ?, ?)").run(id, sealText(Buffer.from(new Float32Array(a.embedding).buffer).toString("base64"), this.dataDir), this.clock());
    return { id };
  }

  find(name: string): { id: number; name: string; relation: string } | null {
    const r = this.db.prepare("select id, name, relation from people where lower(name) = lower(?)").get(clean(name, 80)) as { id: number; name: string; relation: string } | undefined;
    return r ?? null;
  }

  list(): PersonView[] {
    const rows = this.db.prepare("select id, name, relation, created_at as addedAt from people order by name").all() as Omit<PersonView, "usable">[];
    return rows.map((p) => {
      const faces = this.db.prepare("select id, vec from person_faces where person_id = ?").all(p.id) as { id: number; vec: string }[];
      return { ...p, usable: faces.some((f) => this.vector(f.id, f.vec) !== null) };
    });
  }

  /** For each face (128 numbers), the person it matches best if that is close enough, otherwise null. */
  match(embeddings: number[][]): (Match | null)[] {
    const rows = this.db
      .prepare("select f.id as fid, f.vec as vec, p.id as pid, p.name as name, p.relation as relation from person_faces f join people p on p.id = f.person_id")
      .all() as { fid: number; vec: string; pid: number; name: string; relation: string }[];
    const known = rows.map((r) => ({ ...r, v: this.vector(r.fid, r.vec) })).filter((r): r is typeof r & { v: Float32Array } => r.v !== null);
    return embeddings.map((e) => {
      if (e.length !== DIM || e.some((x) => !Number.isFinite(x))) return null;
      let best: Match | null = null;
      for (const k of known) {
        const score = cosine(e, k.v);
        if (score >= FACE_SIMILARITY_THRESHOLD && (!best || score > best.score)) best = { id: k.pid, name: k.name, relation: k.relation, score };
      }
      return best;
    });
  }

  remove(id: number): void {
    const faces = this.db.prepare("select id from person_faces where person_id = ?").all(id) as { id: number }[];
    for (const f of faces) this.cache.delete(f.id);
    this.db.prepare("delete from person_faces where person_id = ?").run(id);
    this.db.prepare("delete from people where id = ?").run(id);
  }

  forgetAll(): void {
    this.cache.clear();
    this.db.prepare("delete from person_faces").run();
    this.db.prepare("delete from people").run();
  }
}
