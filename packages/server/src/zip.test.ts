import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { crc32, zipDirectory } from "./zip";

/** A small reader, so the test checks the archive itself instead of trusting the writer. */
function readZip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  expect(eocd).toBeGreaterThanOrEqual(0);
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const usize = buf.readUInt32LE(p + 24);
    const nlen = buf.readUInt16LE(p + 28);
    const xlen = buf.readUInt16LE(p + 30);
    const clen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString("utf8");
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    const lnlen = buf.readUInt16LE(local + 26);
    const lxlen = buf.readUInt16LE(local + 28);
    const raw = buf.subarray(local + 30 + lnlen + lxlen, local + 30 + lnlen + lxlen + csize);
    const data = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    expect(data.length).toBe(usize);
    expect(crc32(data)).toBe(crc);
    out.set(name, data);
    p += 46 + nlen + xlen + clen;
  }
  return out;
}

describe("crc32", () => {
  it("is the standard one", () => {
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
    expect(crc32(Buffer.alloc(0))).toBe(0);
  });
});

describe("zipDirectory", () => {
  it("holds every file under one folder name, with the same bytes, and folders inside folders", () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-zip-"));
    mkdirSync(join(dir, "icons"));
    writeFileSync(join(dir, "manifest.json"), '{"name":"x"}');
    writeFileSync(join(dir, "background.js"), "a".repeat(5000));
    writeFileSync(join(dir, "icons", "i16.png"), Buffer.from([0, 1, 2, 3, 255, 254]));
    writeFileSync(join(dir, "empty.txt"), "");
    const files = readZip(zipDirectory(dir, "friend-chrome-extension"));
    expect([...files.keys()].sort()).toEqual(["friend-chrome-extension/background.js", "friend-chrome-extension/empty.txt", "friend-chrome-extension/icons/i16.png", "friend-chrome-extension/manifest.json"]);
    expect(files.get("friend-chrome-extension/manifest.json")!.toString()).toBe('{"name":"x"}');
    expect(files.get("friend-chrome-extension/background.js")!.length).toBe(5000);
    expect([...files.get("friend-chrome-extension/icons/i16.png")!]).toEqual([0, 1, 2, 3, 255, 254]);
    expect(files.get("friend-chrome-extension/empty.txt")!.length).toBe(0);
  });
  it("starts with the zip signature and is smaller than the files when they compress", () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-zip-"));
    writeFileSync(join(dir, "a.js"), "abc".repeat(10000));
    const z = zipDirectory(dir, "x");
    expect([...z.subarray(0, 4)]).toEqual([0x50, 0x4b, 0x03, 0x04]);
    expect(z.length).toBeLessThan(3000);
  });
  it("leaves out nothing but dotfiles' folders it should not carry (node_modules, .git)", () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-zip-"));
    mkdirSync(join(dir, "node_modules"));
    mkdirSync(join(dir, ".git"));
    writeFileSync(join(dir, "node_modules", "x.js"), "x");
    writeFileSync(join(dir, ".git", "HEAD"), "x");
    writeFileSync(join(dir, "ok.js"), "x");
    expect([...readZip(zipDirectory(dir, "x")).keys()]).toEqual(["x/ok.js"]);
  });
});
