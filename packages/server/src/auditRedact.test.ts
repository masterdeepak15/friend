import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Audit } from "./audit";
import { maskText, redactDetail } from "./auditRedact";
import { openDb } from "./db";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const parse = (d: unknown) => JSON.parse(redactDetail(d).json);

describe("masking secrets in what is logged", () => {
  it("masks by key name at any depth", () => {
    const out = parse({ password: "hunter2", nested: { PIN: "123456", list: [{ "x-api-key": "k" }, { Authorization: "Bearer zzz" }], cookie: "a=b" }, ok: "fine" });
    expect(out).toEqual({ password: "[redacted]", nested: { PIN: "[redacted]", list: [{ "x-api-key": "[redacted]" }, { Authorization: "[redacted]" }], cookie: "[redacted]" }, ok: "fine" });
  });

  it("keeps a yes/no flag whose name mentions a secret (needsPin: false), and still masks every other kind of value", () => {
    expect(parse({ needsPin: false, pinUsed: true, token: null, pin: 123456, secret: { a: 1 }, apiKey: "k" })).toEqual({ needsPin: false, pinUsed: true, token: null, pin: "[redacted]", secret: "[redacted]", apiKey: "[redacted]" });
  });

  it("masks things that look like secrets inside text", () => {
    const text = "curl -H 'Authorization: Bearer abcDEF123456' https://x.test --key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv and bot 123456789:AAEhBP0abcdefghijklmnopqrstuvwxyz1 and 0123456789abcdef0123456789abcdef01234567 done";
    const masked = maskText(text);
    expect(masked).not.toMatch(/abcDEF123456/);
    expect(masked).not.toMatch(/sk-ant-api03/);
    expect(masked).not.toMatch(/AAEhBP0abcdefghijklmnopqrstuvwxyz1/);
    expect(masked).not.toMatch(/0123456789abcdef0123456789abcdef01234567/);
    expect(masked).toContain("https://x.test");
    expect(masked).toContain("done");
    expect(parse({ command: text }).command).toBe(masked);
  });

  it("leaves ordinary text, paths and commands alone", () => {
    const d = { command: "git status", path: "D:\\ClaudeWorkspace\\friend\\README.md", url: "https://example.com/a?b=c", n: 3, t: true, nothing: null };
    expect(parse(d)).toEqual(d);
  });

  it("cuts an entry over 8 KB, keeps it valid JSON, and keeps the hash of the whole", () => {
    const big = { output: "x".repeat(20_000), small: "kept" };
    const full = JSON.stringify(big);
    const r = redactDetail(big);
    expect(Buffer.byteLength(r.json)).toBeLessThanOrEqual(8192);
    expect(r.truncated).toBe(true);
    expect(r.fullHash).toBe(createHash("sha256").update(full).digest("hex"));
    const back = JSON.parse(r.json);
    expect(back.small).toBe("kept");
    expect(back.output.length).toBeLessThan(20_000);
  });

  it("an entry that fits is not cut and has no hash", () => {
    const r = redactDetail({ a: "b" });
    expect(r).toEqual({ json: '{"a":"b"}', truncated: false, fullHash: null });
  });

  it("an object that cannot be written (circular, BigInt, a throwing getter) never throws", () => {
    const circular: Record<string, unknown> = { a: 1 };
    circular.self = circular;
    const thrower = { get boom(): string { throw new Error("no"); } };
    for (const bad of [circular, { n: BigInt(5) }, thrower]) {
      const r = redactDetail(bad);
      expect(JSON.parse(r.json)).toEqual({ unserializable: true });
    }
  });

  it("Audit.record stores the masked and capped detail, with a truncated flag and the hash of the whole", () => {
    const a = new Audit(openDb(mkdtempSync(join(tmpdir(), "friend-redact-"))));
    a.record({ kind: "tool.start", actorKind: "assistant", detail: { password: "p", output: "y".repeat(30_000) } });
    const row = a.list(1)[0]!;
    expect(row.truncated).toBe(true);
    expect(row.detail.password).toBe("[redacted]");
    expect(typeof row.detail._fullHash).toBe("string");
    expect(a.verify()).toMatchObject({ ok: true });
  });
});
