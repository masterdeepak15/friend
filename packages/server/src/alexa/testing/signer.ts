import { createSign } from "node:crypto";
import { generate } from "selfsigned";

export interface SignerOptions {
  /** The name in the leaf certificate (Amazon's is echo-api.amazon.com). */
  san?: string;
  notBefore?: Date;
  notAfter?: Date;
}

export interface TestSigner {
  /** The throwaway root the verifier is told to trust. */
  rootPem: string;
  /** What "Amazon's certificate URL" serves: the leaf certificate. */
  chainPem: string;
  /** The Signature-256 header value for a body. */
  sign(body: Buffer | string): string;
}

/**
 * A stand-in for Amazon's signing certificate, made fresh for a test: a root and a leaf signed by it. Nothing here touches the
 * network or Amazon; the verifier is handed `rootPem` as the only root it trusts.
 */
export async function testAlexaSigner(o: SignerOptions = {}): Promise<TestSigner> {
  const root = await generate([{ name: "commonName", value: "Friend Test Root" }], {
    algorithm: "sha256",
    keySize: 2048,
    extensions: [{ name: "basicConstraints", cA: true }, { name: "keyUsage", keyCertSign: true, digitalSignature: true }],
  });
  const leaf = await generate([{ name: "commonName", value: "Friend Test Leaf" }], {
    algorithm: "sha256",
    keySize: 2048,
    notBeforeDate: o.notBefore ?? new Date(Date.now() - 3600_000),
    notAfterDate: o.notAfter,
    ca: { key: root.private, cert: root.cert },
    extensions: [
      { name: "basicConstraints", cA: false },
      { name: "keyUsage", digitalSignature: true },
      { name: "subjectAltName", altNames: [{ type: 2, value: o.san ?? "echo-api.amazon.com" }] },
    ],
  });
  return {
    rootPem: root.cert,
    chainPem: leaf.cert,
    sign: (body) => createSign("RSA-SHA256").update(body).sign(leaf.private, "base64"),
  };
}
