import { isIPv4, isIPv6 } from "node:net";

const LOCAL_NAMES = (h: string): boolean => h === "localhost" || h.endsWith(".localhost");

function privateV4(h: string): boolean {
  const [a, b] = h.split(".").map(Number) as [number, number];
  return a === 0 || a === 10 || a === 127 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
}

/** Expands an IPv6 address (no brackets) into eight 16-bit groups. */
function groups(h: string): number[] {
  let s = h;
  const v4 = s.match(/(\d+\.\d+\.\d+\.\d+)$/);
  if (v4) {
    const p = v4[1]!.split(".").map(Number) as [number, number, number, number];
    s = s.slice(0, -v4[1]!.length) + ((p[0] << 8) | p[1]).toString(16) + ":" + ((p[2] << 8) | p[3]).toString(16);
  }
  const [head = "", tail = ""] = s.split("::");
  const h1 = head ? head.split(":") : [];
  const t1 = s.includes("::") ? (tail ? tail.split(":") : []) : [];
  const fill = s.includes("::") ? Array(8 - h1.length - t1.length).fill("0") : [];
  return [...h1, ...fill, ...t1].map((x) => parseInt(x || "0", 16));
}

function privateV6(h: string): boolean {
  const g = groups(h);
  if (g.length !== 8 || g.some(Number.isNaN)) return true;
  if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return true; // :: and ::1
  const first = g[0]!;
  if ((first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00) return true; // unique-local, link-local, multicast
  if (g.slice(0, 5).every((x) => x === 0) && g[5] === 0xffff) return privateV4(`${g[6]! >> 8}.${g[6]! & 255}.${g[7]! >> 8}.${g[7]! & 255}`); // IPv4-mapped
  return false;
}

function isLoopbackHost(h: string): boolean {
  return LOCAL_NAMES(h) || (isIPv4(h) && h.startsWith("127.")) || h === "::1";
}

/**
 * An address that came from a server we do not control (discovery documents, token endpoints, authorization URLs).
 * Refuses anything that is not https, and any private, link-local or loopback address, so a hostile server cannot aim Friend at the owner's network.
 * With allowLoopback, a server on this PC (http or https on localhost / 127.x) is accepted too.
 */
export function assertSafeUrl(raw: string, opts: { allowLoopback?: boolean } = {}): URL {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error("That is not a valid web address.");
  }
  const host = u.hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (opts.allowLoopback && (u.protocol === "http:" || u.protocol === "https:") && isLoopbackHost(host)) return u;
  if (u.protocol !== "https:") throw new Error("Only https:// addresses are allowed.");
  if (LOCAL_NAMES(host) || (isIPv4(host) && privateV4(host)) || (isIPv6(host) && privateV6(host))) throw new Error("That address points inside a private network.");
  return u;
}
