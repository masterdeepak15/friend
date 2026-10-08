import type { Db } from "../db";
import { decrypt, encrypt } from "./crypto";

export type VoiceTrust = "owner" | "challenge" | "guest";

function assertVector(v: readonly number[], what = "vector"): void {
  if (v.length === 0) throw new Error(`${what} is empty`);
  for (const x of v) if (!Number.isFinite(x)) throw new Error(`${what} must contain only finite numbers`);
}

/** Cosine similarity of two voiceprints (1 = same direction). Zero vectors score 0. */
export function cosine(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) throw new Error(`vectors differ in length (${a.length} vs ${b.length})`);
  assertVector(a);
  assertVector(b);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

/** The normalized mean of several voiceprints: the owner's voice. */
export function centroid(list: readonly (readonly number[])[]): number[] {
  if (list.length === 0) throw new Error("no voiceprints to combine");
  const dim = list[0]!.length;
  const sum = new Array<number>(dim).fill(0);
  for (const v of list) {
    if (v.length !== dim) throw new Error(`voiceprints differ in length (${dim} vs ${v.length})`);
    assertVector(v);
    for (let i = 0; i < dim; i++) sum[i]! += v[i]!;
  }
  const norm = Math.sqrt(sum.reduce((s, x) => s + x * x, 0));
  if (norm < 1e-9) throw new Error("the voiceprints cancel each other out (zero vector)");
  return sum.map((x) => x / norm);
}

export interface Consistency {
  ok: boolean;
  mean: number;
  min: number;
}

/** Do the enrollment samples sound like one person? Every sample must agree with the average voice. */
export function checkConsistency(list: readonly (readonly number[])[], minSimilarity = 0.55): Consistency {
  const c = centroid(list);
  const sims = list.map((v) => cosine(v, c));
  const min = Math.min(...sims);
  return { ok: min >= minSimilarity, mean: sims.reduce((s, x) => s + x, 0) / sims.length, min };
}

export interface TrustThresholds {
  accept: number;
  challenge: number;
}

/** owner at or above `accept`, a PIN challenge at or above `challenge`, otherwise a guest. */
export function decideTrust(score: number, t: TrustThresholds): VoiceTrust {
  if (!Number.isFinite(score)) return "guest";
  if (score >= t.accept) return "owner";
  if (score >= t.challenge) return "challenge";
  return "guest";
}

export interface VoiceprintInfo {
  samples: number;
  model: string;
  createdAt: number;
}

/** The owner's voiceprint, encrypted at rest. Only the averaged voice is stored, never the recordings. */
export class Voiceprint {
  constructor(private db: Db, private key: Buffer, private clock: () => number = Date.now) {}

  exists(): boolean {
    return !!this.db.prepare("select 1 from voiceprint where id = 1").get();
  }

  info(): VoiceprintInfo | null {
    const r = this.db.prepare("select samples, model, created_at c from voiceprint where id = 1").get() as
      | { samples: number; model: string; c: number }
      | undefined;
    return r ? { samples: r.samples, model: r.model, createdAt: r.c } : null;
  }

  enroll(embeddings: readonly (readonly number[])[], model: string): void {
    const c = centroid(embeddings);
    const blob = encrypt(this.key, Buffer.from(new Float32Array(c).buffer));
    this.db
      .prepare(
        "insert into voiceprint (id, centroid_enc, dim, samples, model, created_at) values (1, ?, ?, ?, ?, ?) " +
          "on conflict(id) do update set centroid_enc = excluded.centroid_enc, dim = excluded.dim, samples = excluded.samples, " +
          "model = excluded.model, created_at = excluded.created_at",
      )
      .run(blob, c.length, embeddings.length, model, this.clock());
  }

  /** Similarity of a new voiceprint to the owner's, or null when nobody is enrolled. Throws on a wrong key. */
  score(embedding: readonly number[]): number | null {
    const row = this.db.prepare("select centroid_enc e, dim from voiceprint where id = 1").get() as { e: Buffer; dim: number } | undefined;
    if (!row) return null;
    const raw = decrypt(this.key, row.e);
    const stored = Array.from(new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4));
    return cosine(stored, embedding);
  }

  clear(): void {
    this.db.prepare("delete from voiceprint where id = 1").run();
  }
}
