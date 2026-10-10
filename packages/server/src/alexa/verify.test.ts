import { describe, expect, it, vi } from "vitest";
import { testAlexaSigner, type TestSigner } from "./testing/signer";
import { verifyAlexaRequest } from "./verify";

const URL_OK = "https://s3.amazonaws.com/echo.api/echo-api-cert-7.pem";
const NOW = Date.now();
const body = (ts = new Date(NOW).toISOString(), extra: object = {}) => Buffer.from(JSON.stringify({ version: "1.0", request: { type: "LaunchRequest", requestId: "r1", timestamp: ts, locale: "en-IN" }, ...extra }));

let signer: TestSigner;
async function setup(over: Parameters<typeof testAlexaSigner>[0] = {}) {
  signer = await testAlexaSigner(over);
  const fetchCert = vi.fn(async () => signer.chainPem);
  const run = (raw: Buffer, headers: Record<string, string | undefined> = {}, now = NOW) =>
    verifyAlexaRequest({
      headers: { signaturecertchainurl: URL_OK, "signature-256": signer.sign(raw), ...headers },
      rawBody: raw,
      now,
      fetchCert,
      roots: [signer.rootPem],
    });
  return { run, fetchCert };
}

describe("a request Amazon really signed", () => {
  it("is accepted, and its body is returned", async () => {
    const { run } = await setup();
    const out = await run(body());
    expect(out.ok).toBe(true);
    if (out.ok) expect(out.body.request.type).toBe("LaunchRequest");
  });

  it("fetches the certificate once and uses it again", async () => {
    const { run, fetchCert } = await setup();
    await run(body());
    await run(body());
    expect(fetchCert).toHaveBeenCalledTimes(1);
  });

  it("is accepted 149 seconds from the clock, either way", async () => {
    const { run } = await setup();
    expect((await run(body(new Date(NOW - 149_000).toISOString()))).ok).toBe(true);
    expect((await run(body(new Date(NOW + 149_000).toISOString()))).ok).toBe(true);
  });
});

describe("a request that must be refused", () => {
  it("changed after it was signed", async () => {
    const { run } = await setup();
    const raw = body();
    const sig = signer.sign(raw);
    const out = await run(Buffer.from(raw.toString().replace("en-IN", "hi-IN")), { "signature-256": sig });
    expect(out).toMatchObject({ ok: false, status: 400 });
  });

  it("without the headers", async () => {
    const { run } = await setup();
    expect(await run(body(), { "signature-256": undefined })).toMatchObject({ ok: false, status: 400 });
    expect(await run(body(), { signaturecertchainurl: undefined })).toMatchObject({ ok: false, status: 400 });
  });

  it.each([
    ["http", "http://s3.amazonaws.com/echo.api/echo-api-cert.pem"],
    ["another host", "https://example.com/echo.api/echo-api-cert.pem"],
    ["a look-alike host", "https://s3.amazonaws.com.evil.com/echo.api/echo-api-cert.pem"],
    ["a user in the address", "https://s3.amazonaws.com@evil.com/echo.api/echo-api-cert.pem"],
    ["another path", "https://s3.amazonaws.com/other/echo-api-cert.pem"],
    ["a path that climbs out", "https://s3.amazonaws.com/echo.api/../evil/cert.pem"],
    ["another port", "https://s3.amazonaws.com:8443/echo.api/echo-api-cert.pem"],
    ["not an address", "not a url"],
  ])("with a certificate address that is %s", async (_name, url) => {
    const { run, fetchCert } = await setup();
    expect(await run(body(), { signaturecertchainurl: url })).toMatchObject({ ok: false, status: 400 });
    expect(fetchCert).not.toHaveBeenCalled();
  });

  it("with port 443 written out, the address is fine", async () => {
    const { run } = await setup();
    expect((await run(body(), { signaturecertchainurl: "https://s3.amazonaws.com:443/echo.api/echo-api-cert.pem" })).ok).toBe(true);
  });

  it("signed with an expired certificate", async () => {
    const { run } = await setup({ notBefore: new Date(NOW - 2 * 365 * 86400_000), notAfter: new Date(NOW - 365 * 86400_000) });
    expect(await run(body())).toMatchObject({ ok: false, status: 400 });
  });

  it("signed with a certificate that is not Alexa's", async () => {
    const { run } = await setup({ san: "evil.example.com" });
    expect(await run(body())).toMatchObject({ ok: false, status: 400 });
  });

  it("signed by a certificate that does not lead to a trusted root", async () => {
    const { run } = await setup();
    const other = await testAlexaSigner();
    const out = await verifyAlexaRequest({
      headers: { signaturecertchainurl: URL_OK, "signature-256": signer.sign(body()) },
      rawBody: body(),
      now: NOW,
      fetchCert: async () => signer.chainPem,
      roots: [other.rootPem],
    });
    expect(out).toMatchObject({ ok: false, status: 400 });
    expect(run).toBeTypeOf("function");
  });

  it("whose certificate cannot be fetched or is not a certificate", async () => {
    const { run } = await setup();
    const broken = await verifyAlexaRequest({ headers: { signaturecertchainurl: URL_OK, "signature-256": "AAAA" }, rawBody: body(), now: NOW, fetchCert: async () => { throw new Error("down"); }, roots: [signer.rootPem] });
    expect(broken).toMatchObject({ ok: false, status: 400 });
    const junk = await verifyAlexaRequest({ headers: { signaturecertchainurl: URL_OK, "signature-256": "AAAA" }, rawBody: body(), now: NOW, fetchCert: async () => "not a pem", roots: [signer.rootPem] });
    expect(junk).toMatchObject({ ok: false, status: 400 });
    expect(run).toBeTypeOf("function");
  });

  it("151 seconds from the clock, old or in the future", async () => {
    const { run } = await setup();
    expect(await run(body(new Date(NOW - 151_000).toISOString()))).toMatchObject({ ok: false, status: 400 });
    expect(await run(body(new Date(NOW + 151_000).toISOString()))).toMatchObject({ ok: false, status: 400 });
  });

  it("with a body that is not JSON, or has no timestamp", async () => {
    const { run } = await setup();
    expect(await run(Buffer.from("hello"))).toMatchObject({ ok: false, status: 400 });
    expect(await run(Buffer.from(JSON.stringify({ version: "1.0", request: { type: "LaunchRequest" } })))).toMatchObject({ ok: false, status: 400 });
    expect(await run(Buffer.from(JSON.stringify({ version: "1.0", request: { type: "LaunchRequest", timestamp: "yesterday" } })))).toMatchObject({ ok: false, status: 400 });
  });

  it("checks the signature before it reads the body", async () => {
    const { run } = await setup();
    const out = await run(Buffer.from("{not json"), { "signature-256": "AAAA" });
    expect(out).toMatchObject({ ok: false, status: 400, reason: expect.stringMatching(/signature/i) });
  });
});
