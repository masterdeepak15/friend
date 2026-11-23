import { inflateRawSync } from "node:zlib";

/** More files than this in one archive is refused: no real document has them. */
const MAX_ENTRIES = 5000;

/** One file inside a zip archive (a Word, Excel or PowerPoint document is one). */
export interface ZipEntry {
  name: string;
  method: number;
  compressed: number;
  size: number;
  offset: number;
}

/** The list of files in a zip archive, read from its central directory. Throws when the bytes are not a zip file. */
export function readZip(buf: Buffer): Map<string, ZipEntry> {
  const out = new Map<string, ZipEntry>();
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 65535); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error("not a zip file");
  const count = buf.readUInt16LE(end + 10);
  if (count > MAX_ENTRIES) throw new Error("the archive lists too many files");
  let p = buf.readUInt32LE(end + 16);
  for (let n = 0; n < count && p + 46 <= buf.length; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break;
    const method = buf.readUInt16LE(p + 10);
    const compressed = buf.readUInt32LE(p + 20);
    const size = buf.readUInt32LE(p + 24);
    const nameLen = buf.readUInt16LE(p + 28);
    const extra = buf.readUInt16LE(p + 30);
    const comment = buf.readUInt16LE(p + 32);
    const offset = buf.readUInt32LE(p + 42);
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    out.set(name, { name, method, compressed, size, offset });
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

/** The bytes of one file of the archive. A file that would be larger than `maxBytes` once unpacked is refused, so a small archive cannot fill the memory. */
export function readEntry(buf: Buffer, e: ZipEntry, maxBytes: number): Buffer {
  if (e.size === 0xffffffff || e.compressed === 0xffffffff) throw new Error("a very large archive (zip64) is not supported");
  if (e.size > maxBytes) throw new Error("a file inside is too large");
  if (e.offset + 30 > buf.length || buf.readUInt32LE(e.offset) !== 0x04034b50) throw new Error("damaged zip file");
  const start = e.offset + 30 + buf.readUInt16LE(e.offset + 26) + buf.readUInt16LE(e.offset + 28);
  const data = buf.subarray(start, start + e.compressed);
  if (e.method === 0) return Buffer.from(data);
  if (e.method === 8) return inflateRawSync(data, { maxOutputLength: maxBytes });
  throw new Error("an unsupported way of compressing");
}
