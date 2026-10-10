import { createVerify, X509Certificate } from "node:crypto";
import { rootCertificates } from "node:tls";

/** The parts of an Alexa request Friend reads. Everything else in it is ignored. */
export interface AlexaRequestBody {
  version: string;
  session?: { new?: boolean; sessionId?: string; user?: { userId?: string }; application?: { applicationId?: string } };
  context?: { System?: { application?: { applicationId?: string }; user?: { userId?: string }; device?: { deviceId?: string } } };
  request: {
    type: string;
    requestId?: string;
    timestamp: string;
    locale?: string;
    intent?: { name: string; slots?: Record<string, { value?: string }> };
  };
}

export interface VerifyOptions {
  headers: Record<string, string | string[] | undefined>;
  rawBody: Buffer;
  /** Epoch milliseconds. */
  now: number;
  /** Downloads the PEM certificate chain from the address in the request. */
  fetchCert: (url: string) => Promise<string>;
  /** PEM roots to trust. Defaults to the roots Node knows. Tests pass their own. */
  roots?: string[];
}

export type Verified = { ok: true; body: AlexaRequestBody } | { ok: false; status: 400; reason: string };

const CERT_HOST = "s3.amazonaws.com";
const CERT_PATH = "/echo.api/";
const ALEXA_NAME = "echo-api.amazon.com";
const TOLERANCE_MS = 150_000;
const MAX_CHAIN = 5;
const MAX_PEM = 20_000;
const MAX_CACHED = 8;

const refuse = (reason: string): Verified => ({ ok: false, status: 400, reason });
const header = (h: VerifyOptions["headers"], name: string): string | undefined => {
  const v = h[name];
  return typeof v === "string" ? v : Array.isArray(v) ? v[0] : undefined;
};

/** Amazon's certificate address: https, its own host, a path under /echo.api/, no user name, port 443 or none. */
function certUrl(raw: string): URL | null {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.hostname.toLowerCase() !== CERT_HOST || !u.pathname.startsWith(CERT_PATH)) return null;
  if (u.username || u.password || (u.port !== "" && u.port !== "443")) return null;
  return u;
}

const parseChain = (pem: string): X509Certificate[] | null => {
  if (pem.length > MAX_PEM) return null;
  const blocks = pem.match(/-----BEGIN CERTIFICATE-----[\s\S]+?-----END CERTIFICATE-----/g);
  if (!blocks || blocks.length > MAX_CHAIN) return null;
  try {
    return blocks.map((b) => new X509Certificate(b));
  } catch {
    return null;
  }
};

let defaultRoots: X509Certificate[] | null = null;
const rootsFrom = (pems?: string[]): X509Certificate[] => {
  if (pems) return pems.flatMap((p) => parseChain(p) ?? []);
  defaultRoots ??= rootCertificates.flatMap((p) => {
    try {
      return [new X509Certificate(p)];
    } catch {
      return [];
    }
  });
  return defaultRoots;
};

/** The chain is current, names Alexa, and leads from the first certificate to a root we trust. */
function chainProblem(chain: X509Certificate[], roots: X509Certificate[], now: number): string | null {
  for (const c of chain) if (now < Date.parse(c.validFrom) || now > Date.parse(c.validTo)) return "the certificate is not valid now";
  const leaf = chain[0]!;
  if (!(leaf.subjectAltName ?? "").split(",").some((s) => s.trim() === `DNS:${ALEXA_NAME}`)) return "the certificate is not Alexa's";
  for (let i = 0; i < chain.length - 1; i++) {
    if (!chain[i]!.checkIssued(chain[i + 1]!) || !chain[i]!.verify(chain[i + 1]!.publicKey)) return "the certificate chain is broken";
  }
  const top = chain[chain.length - 1]!;
  const trusted = roots.some((r) => (top.fingerprint256 === r.fingerprint256) || (top.checkIssued(r) && top.verify(r.publicKey)));
  return trusted ? null : "the certificate does not lead to a trusted root";
}

const cache = new Map<string, X509Certificate[]>();

/**
 * Checks that a request really came from Amazon, in this order: the certificate address, the certificate, the signature over
 * the raw body, and only then the body itself and its timestamp (150 seconds either way). Any failure is HTTP 400.
 */
export async function verifyAlexaRequest(o: VerifyOptions): Promise<Verified> {
  const url = certUrl(header(o.headers, "signaturecertchainurl") ?? "");
  const signature = header(o.headers, "signature-256");
  if (!url) return refuse("bad certificate address");
  if (!signature) return refuse("missing signature");

  const key = url.href;
  let chain = cache.get(key);
  if (chain && chainProblem(chain, rootsFrom(o.roots), o.now)) chain = undefined;
  if (!chain) {
    let pem: string;
    try {
      pem = await o.fetchCert(key);
    } catch {
      return refuse("the certificate could not be fetched");
    }
    const parsed = parseChain(pem);
    if (!parsed) return refuse("the certificate is not usable");
    const problem = chainProblem(parsed, rootsFrom(o.roots), o.now);
    if (problem) return refuse(problem);
    chain = parsed;
    cache.set(key, chain);
    while (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
  }

  let good = false;
  try {
    good = createVerify("RSA-SHA256").update(o.rawBody).verify(chain[0]!.publicKey, Buffer.from(signature, "base64"));
  } catch {
    good = false;
  }
  if (!good) return refuse("bad signature");

  let body: AlexaRequestBody;
  try {
    body = JSON.parse(o.rawBody.toString("utf8")) as AlexaRequestBody;
  } catch {
    return refuse("the body is not JSON");
  }
  const stamp = typeof body?.request?.timestamp === "string" ? Date.parse(body.request.timestamp) : NaN;
  if (!Number.isFinite(stamp)) return refuse("no timestamp");
  if (Math.abs(o.now - stamp) > TOLERANCE_MS) return refuse("the request is too old or too new");
  return { ok: true, body };
}
