import { createHash } from "node:crypto";

/** One entry's details may be at most this many bytes of JSON. */
export const DETAIL_MAX_BYTES = 8192;
const MASK = "[redacted]";
const SECRET_KEY = /pass(word)?|pin|token|secret|key|authorization|cookie/i;

/** Things that look like secrets inside text: a Bearer header, an sk- key, a Telegram bot token, a long hex run. */
const VALUE_PATTERNS: RegExp[] = [/Bearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, /\bsk-[A-Za-z0-9_-]{16,}/g, /\b\d{6,12}:[A-Za-z0-9_-]{30,}\b/g, /\b[0-9a-fA-F]{32,}\b/g];
/** A long run of base64-looking characters is only a secret when it mixes digits, capitals and lower case (a long kebab-case name is not). */
const LONG_RUN = /\b[A-Za-z0-9+_-]{40,}\b/g;

export function maskText(text: string): string {
  let out = text;
  for (const p of VALUE_PATTERNS) out = out.replace(p, MASK);
  return out.replace(LONG_RUN, (m) => (/[0-9]/.test(m) && /[A-Z]/.test(m) && /[a-z]/.test(m) ? MASK : m));
}

/** Whether a name looks like it holds a secret (a password, a PIN, a key, a token). */
export const isSecretKey = (name: string): boolean => SECRET_KEY.test(name);

/** The trail's own fingerprints (a hash, a seal) are long hex runs but are not secrets: they are what proves the log is whole. */
const isOwnHash = (key: string, v: unknown): boolean => typeof v === "string" && /(hash|seal)$/i.test(key) && (/^[0-9a-f]{64}$/i.test(v) || /^Friend audit seal \d{4}-\d{2}-\d{2}: rows 1-\d+, hash [0-9a-f]{64}$/.test(v));

function mask(value: unknown, path: Set<object>): unknown {
  if (typeof value === "string") return maskText(value);
  if (!value || typeof value !== "object") return value;
  if (path.has(value)) throw new Error("circular");
  path.add(value);
  try {
    if (Array.isArray(value)) return value.map((v) => mask(v, path));
    // a yes/no or an empty value under a secret-looking name (needsPin: false) holds no secret; text, numbers and objects do
    return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, isOwnHash(k, v) ? v : SECRET_KEY.test(k) && typeof v !== "boolean" && v != null ? MASK : mask(v, path)]));
  } finally {
    path.delete(value);
  }
}

/** The string values of an object or array, so the longest can be shortened first. */
type Slot = { owner: Record<string | number, unknown>; key: string | number };
function strings(value: unknown, out: Slot[] = []): Slot[] {
  if (Array.isArray(value)) value.forEach((v, i) => (typeof v === "string" ? out.push({ owner: value as unknown as Record<number, unknown>, key: i }) : strings(v, out)));
  else if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) typeof v === "string" ? out.push({ owner: value as Record<string, unknown>, key: k }) : strings(v, out);
  return out;
}

const bytes = (s: string) => Buffer.byteLength(s);

/**
 * Masks secrets (by key name and by what the text looks like) and writes the details as JSON that fits 8 KB. A longer entry is cut
 * (the longest texts first), keeps the hash of the whole, and says so. Never throws: what cannot be written is `{ unserializable: true }`.
 */
export function redactDetail(detail: unknown): { json: string; truncated: boolean; fullHash: string | null } {
  let masked: unknown;
  let full: string;
  try {
    masked = mask(detail ?? {}, new Set());
    full = JSON.stringify(masked) ?? "{}";
  } catch {
    return { json: '{"unserializable":true}', truncated: false, fullHash: null };
  }
  if (bytes(full) <= DETAIL_MAX_BYTES) return { json: full, truncated: false, fullHash: null };

  const fullHash = createHash("sha256").update(full).digest("hex");
  const room = DETAIL_MAX_BYTES - 100; // for the hash that is added
  const copy = JSON.parse(full) as unknown;
  let json = full;
  for (let i = 0; i < 400 && bytes(json) > room; i++) {
    const longest = strings(copy).sort((a, b) => String(b.owner[b.key]).length - String(a.owner[a.key]).length)[0];
    if (!longest) break;
    const text = String(longest.owner[longest.key]);
    const keep = Math.max(0, text.length - (bytes(json) - room) - 16);
    longest.owner[longest.key] = `${text.slice(0, Math.min(keep, text.length - 1))}…[cut]`;
    json = JSON.stringify(copy);
  }
  if (bytes(json) > room) {
    // many small values: keep the start of the text only
    json = JSON.stringify({ _cut: true, _preview: full.slice(0, 4000) });
  }
  const withHash = JSON.stringify({ ...(JSON.parse(json) as Record<string, unknown>), _fullHash: fullHash });
  return { json: withHash, truncated: true, fullHash };
}
