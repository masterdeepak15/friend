import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

const KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** The key that encrypts the voiceprint at rest. Created once, kept in a file only the owner can read. */
export function loadOrCreateKey(path: string): Buffer {
  if (existsSync(path)) {
    const key = readFileSync(path);
    if (key.length !== KEY_BYTES) throw new Error(`invalid voice key file (expected ${KEY_BYTES} bytes): ${path}`);
    return key;
  }
  mkdirSync(dirname(path), { recursive: true });
  const key = randomBytes(KEY_BYTES);
  writeFileSync(path, key, { mode: 0o600 });
  try {
    chmodSync(path, 0o600);
  } catch {
    /* permission bits are not supported on every file system */
  }
  return key;
}

/** AES-256-GCM. Output layout: nonce (12) | auth tag (16) | ciphertext. */
export function encrypt(key: Buffer, plain: Buffer): Buffer {
  const iv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]);
}

/** Throws if the key is wrong or the data was changed. */
export function decrypt(key: Buffer, blob: Buffer): Buffer {
  if (blob.length < IV_BYTES + TAG_BYTES) throw new Error("encrypted data is too short");
  const decipher = createDecipheriv("aes-256-gcm", key, blob.subarray(0, IV_BYTES));
  decipher.setAuthTag(blob.subarray(IV_BYTES, IV_BYTES + TAG_BYTES));
  return Buffer.concat([decipher.update(blob.subarray(IV_BYTES + TAG_BYTES)), decipher.final()]);
}
