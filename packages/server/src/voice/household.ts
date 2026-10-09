import type { Db } from "../db";
import { decrypt, encrypt } from "./crypto";
import { centroid, cosine, decideTrust, type TrustThresholds, type VoiceTrust } from "./voiceprint";

/** A mistake the owner can fix (a name already used, too many people). Safe to show as is. */
export class HouseholdError extends Error {}

export const MAX_PEOPLE = 8;
const NAME_MAX = 40;

export interface Person {
  id: number;
  name: string;
  samples: number;
  createdAt: number;
}

export interface Match {
  id: number;
  name: string;
  score: number;
}

/** A name as shown and spoken: trimmed, one line, no control characters. */
export function cleanName(raw: string): string {
  const name = raw.replace(/[\u0000-\u001f\u007f]/g, " ").replace(/\s+/g, " ").trim();
  if (!name) throw new HouseholdError("Enter a name.");
  if (name.length > NAME_MAX) throw new HouseholdError(`A name can be at most ${NAME_MAX} characters.`);
  return name;
}

/**
 * The other people whose voices Friend knows besides the owner (wife, son, daughter...). Like the owner's voiceprint,
 * only the averaged voice is stored, encrypted with the same key; recordings are never kept.
 */
export class Household {
  constructor(private db: Db, private key: Buffer, private clock: () => number = Date.now) {}

  list(): Person[] {
    return (this.db.prepare("select id, name, samples, created_at c from voice_people order by id").all() as { id: number; name: string; samples: number; c: number }[]).map((r) => ({
      id: r.id,
      name: r.name,
      samples: r.samples,
      createdAt: r.c,
    }));
  }

  count(): number {
    return (this.db.prepare("select count(*) n from voice_people").get() as { n: number }).n;
  }

  has(name: string): boolean {
    return !!this.db.prepare("select 1 from voice_people where name = ?").get(name);
  }

  /** Checks a name and the room for one more person, before any recording is made. */
  canAdd(rawName: string): string {
    const name = cleanName(rawName);
    if (this.has(name)) throw new HouseholdError(`${name} is already saved. Remove that voice first to record it again.`);
    if (this.count() >= MAX_PEOPLE) throw new HouseholdError(`Friend knows ${MAX_PEOPLE} people already. Remove one first.`);
    return name;
  }

  add(rawName: string, embeddings: readonly (readonly number[])[], model: string): Person {
    const name = this.canAdd(rawName);
    const c = centroid(embeddings);
    const blob = encrypt(this.key, Buffer.from(new Float32Array(c).buffer));
    const at = this.clock();
    const r = this.db.prepare("insert into voice_people (name, centroid_enc, dim, samples, model, created_at) values (?, ?, ?, ?, ?, ?)").run(name, blob, c.length, embeddings.length, model, at);
    return { id: Number(r.lastInsertRowid), name, samples: embeddings.length, createdAt: at };
  }

  remove(id: number): boolean {
    return this.db.prepare("delete from voice_people where id = ?").run(id).changes > 0;
  }

  /** The person this voice sounds most like, with how much; null when nobody is saved or the voice cannot be compared. */
  identify(embedding: readonly number[]): Match | null {
    let best: Match | null = null;
    const rows = this.db.prepare("select id, name, centroid_enc e, dim from voice_people").all() as { id: number; name: string; e: Buffer; dim: number }[];
    for (const r of rows) {
      if (r.dim !== embedding.length) continue; // saved with another speech model: cannot be compared
      const raw = decrypt(this.key, r.e);
      const stored = Array.from(new Float32Array(raw.buffer, raw.byteOffset, raw.byteLength / 4));
      const score = cosine(stored, embedding);
      if (!best || score > best.score) best = { id: r.id, name: r.name, score };
    }
    return best;
  }
}

export interface WhoSpeaks {
  trust: VoiceTrust | "member";
  /** The person, when trust is "member". */
  person?: Match;
}

/** How much closer a voice must be to one person than to the next before Friend names them. */
export const MARGIN = 0.04;

/**
 * Who is speaking, from how much the voice resembles the owner and the best-matching other person. The owner keeps
 * the rules of decideTrust; a household member is named only when clearly closer to them than to the owner. When two
 * people sound almost alike, nothing is guessed: only the owner's PIN settles it.
 */
export function decideSpeaker(ownerScore: number | null, member: Match | null, t: TrustThresholds): WhoSpeaks {
  if (ownerScore !== null && (!member || ownerScore >= member.score)) {
    const trust = decideTrust(ownerScore, t);
    if (trust === "owner" && member && member.score >= t.accept && ownerScore - member.score < MARGIN) return { trust: "challenge" };
    return { trust };
  }
  if (member) {
    if (member.score >= t.accept && member.score - (ownerScore ?? -1) >= MARGIN) return { trust: "member", person: member };
    if (ownerScore !== null && ownerScore >= t.challenge) return { trust: "challenge" };
  }
  return { trust: "guest" };
}
