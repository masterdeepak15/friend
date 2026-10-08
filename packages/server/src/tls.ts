import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { networkInterfaces } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";
import { generate } from "selfsigned";

export interface TlsFiles {
  key: string;
  cert: string;
}

type Interfaces = () => ReturnType<typeof networkInterfaces>;

const DAYS = 825; // the longest lifetime Apple's browsers accept for a certificate
const RENEW_BEFORE_MS = 30 * 24 * 3600_000;

/** This PC's addresses on the local network (IPv4, not loopback). */
export function lanAddresses(ifaces: Interfaces = networkInterfaces): string[] {
  const out: string[] = [];
  for (const list of Object.values(ifaces())) {
    for (const i of list ?? []) if (i.family === "IPv4" && !i.internal && !out.includes(i.address)) out.push(i.address);
  }
  return out;
}

/** Every name and address the certificate has to cover, so a phone opening https://192.168.x.x:8787 gets a matching one. */
export function tlsHosts(extra: string[] = [], ifaces?: Interfaces): string[] {
  return [...new Set(["localhost", "127.0.0.1", "::1", ...lanAddresses(ifaces), ...extra.map((h) => h.toLowerCase()).filter(Boolean)])];
}

interface Meta {
  hosts: string[];
  expires: number;
}

/**
 * The certificate Friend uses for https:// on this PC. It is made once, kept private in the data folder, and made again
 * only when it is about to run out or this PC's addresses changed. It is self-signed: a phone asks once to trust it.
 */
export async function ensureTlsCert(dataDir: string, extraHosts: string[] = [], ifaces?: Interfaces, now: () => number = Date.now): Promise<TlsFiles> {
  const dir = join(dataDir, "tls");
  const keyFile = join(dir, "key.pem");
  const certFile = join(dir, "cert.pem");
  const metaFile = join(dir, "meta.json");
  const hosts = tlsHosts(extraHosts, ifaces);
  if (existsSync(keyFile) && existsSync(certFile) && existsSync(metaFile)) {
    try {
      const meta = JSON.parse(readFileSync(metaFile, "utf8")) as Meta;
      const covered = hosts.every((h) => meta.hosts.includes(h));
      if (covered && meta.expires - now() > RENEW_BEFORE_MS) return { key: readFileSync(keyFile, "utf8"), cert: readFileSync(certFile, "utf8") };
    } catch {
      /* unreadable: make a new one */
    }
  }
  const altNames = hosts.map((h) => (isIP(h) ? { type: 7 as const, ip: h } : { type: 2 as const, value: h }));
  const pems = await generate([{ name: "commonName", value: "Friend" }], {
    keySize: 2048,
    notBeforeDate: new Date(now() - 24 * 3600_000), // a day back, so a phone whose clock is a little slow still accepts it
    notAfterDate: new Date(now() + DAYS * 24 * 3600_000),
    algorithm: "sha256",
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
      { name: "extKeyUsage", serverAuth: true },
      { name: "subjectAltName", altNames },
    ],
  });
  mkdirSync(dir, { recursive: true });
  writeFileSync(keyFile, pems.private);
  writeFileSync(certFile, pems.cert);
  writeFileSync(metaFile, JSON.stringify({ hosts, expires: now() + DAYS * 24 * 3600_000 } satisfies Meta));
  try {
    chmodSync(keyFile, 0o600);
  } catch {
    /* permission bits unsupported on this OS */
  }
  return { key: pems.private, cert: pems.cert };
}
