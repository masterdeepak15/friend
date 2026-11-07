import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Keys, tokens and passwords in the saved settings file are stored encrypted (AES-256-GCM), so the file alone, pasted into a chat,
 * copied to a backup or synced to a cloud drive, does not give them away. Works the same on every system: no OS key store.
 * The key is a random file next to the settings (secret.key), or, if FRIEND_SECRET_KEY is set, derived from that passphrase and kept off the disk.
 */
const PREFIX = "enc:v1:";
const SECRET_NAME = /(token|secret|password|passphrase|key|sid)$/i;
const keyCache = new Map<string, Buffer>();

function masterKey(dataDir: string): Buffer {
  const pass = process.env.FRIEND_SECRET_KEY;
  const id = pass ? `p:${pass}` : `f:${dataDir}`;
  const hit = keyCache.get(id);
  if (hit) return hit;
  let key: Buffer;
  if (pass) key = scryptSync(pass, "friend-secret-box-v1", 32);
  else {
    const file = join(dataDir, "secret.key");
    if (existsSync(file)) key = Buffer.from(readFileSync(file, "utf8").trim(), "hex");
    else {
      key = randomBytes(32);
      mkdirSync(dataDir, { recursive: true });
      writeFileSync(file, key.toString("hex"), { mode: 0o600 });
      try {
        chmodSync(file, 0o600);
      } catch {
        /* permission bits unsupported on this OS */
      }
    }
    if (key.length !== 32) throw new Error(`${file} is damaged (it must hold a 32-byte key). Restore it from a backup.`);
  }
  keyCache.set(id, key);
  return key;
}

function seal(text: string, key: Buffer): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([c.update(text, "utf8"), c.final()]);
  return PREFIX + [iv, c.getAuthTag(), data].map((b) => b.toString("base64url")).join(".");
}

function open(text: string, key: Buffer): string | null {
  try {
    const [iv, tag, data] = text.slice(PREFIX.length).split(".").map((s) => Buffer.from(s, "base64url"));
    if (!iv || !tag || !data || iv.length !== 12 || tag.length !== 16) return null;
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAuthTag(tag);
    return Buffer.concat([d.update(data), d.final()]).toString("utf8");
  } catch {
    return null;
  }
}

function walk(v: unknown, path: string, visit: (obj: Record<string, unknown>, k: string, path: string) => void): void {
  if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`, visit));
  else if (v && typeof v === "object") {
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      const p = path ? `${path}.${k}` : k;
      visit(o, k, p);
      walk(o[k], p, visit);
    }
  }
}

/** One piece of text sealed with the data folder's key (for example a list of face numbers). */
export function sealText(text: string, dataDir: string): string {
  return seal(text, masterKey(dataDir));
}

/** The text back, or null when it is not sealed, was damaged, or was sealed with another key. */
export function unsealText(text: string, dataDir: string): string | null {
  if (!text.startsWith(PREFIX)) return null;
  try {
    return open(text, masterKey(dataDir));
  } catch {
    return null;
  }
}

/** A copy with every secret-looking text value encrypted. `changed` says whether any plain value was found. */
export function sealSecrets<T>(value: T, dataDir: string): { value: T; changed: boolean } {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  let changed = false;
  walk(copy, "", (o, k) => {
    const s = o[k];
    if (typeof s === "string" && s !== "" && !s.startsWith(PREFIX) && SECRET_NAME.test(k)) {
      o[k] = seal(s, masterKey(dataDir));
      changed = true;
    }
  });
  return { value: copy, changed };
}

/** A copy with every encrypted value opened. One that cannot be opened (wrong key, damaged) becomes "" and is listed in `lost`. */
export function unsealSecrets<T>(value: T, dataDir: string): { value: T; lost: string[] } {
  const copy = JSON.parse(JSON.stringify(value)) as T;
  const lost: string[] = [];
  walk(copy, "", (o, k, p) => {
    const s = o[k];
    if (typeof s !== "string" || !s.startsWith(PREFIX)) return;
    let plain: string | null = null;
    try {
      plain = open(s, masterKey(dataDir));
    } catch {
      plain = null;
    }
    if (plain === null) lost.push(p);
    o[k] = plain ?? "";
  });
  return { value: copy, lost };
}
