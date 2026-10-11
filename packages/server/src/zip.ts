import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

/** The checksum a zip file keeps for every file in it (the same one as gzip and PNG). */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of data) c = TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const SKIP = new Set(["node_modules", ".git"]);
const MAX_FILES = 500;
const MAX_BYTES = 20_000_000;

function walk(dir: string, prefix: string, out: { name: string; path: string }[]): void {
  for (const e of readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
    if (SKIP.has(e.name)) continue;
    const path = join(dir, e.name);
    if (e.isDirectory()) walk(path, `${prefix}${e.name}/`, out);
    else if (e.isFile()) out.push({ name: `${prefix}${e.name}`, path });
  }
}

/** A zip of everything in a folder, all under one folder name inside the archive. Files and bytes are capped: it is meant for a small program, not for a backup. */
export function zipDirectory(dir: string, folder: string): Buffer {
  const files: { name: string; path: string }[] = [];
  walk(dir, `${folder}/`, files);
  if (files.length > MAX_FILES) throw new Error("That folder has too many files to zip.");
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  let total = 0;
  // 1 January 2020, so the same folder always makes the same archive
  const time = 0;
  const date = ((2020 - 1980) << 9) | (1 << 5) | 1;
  for (const f of files) {
    const data = readFileSync(f.path);
    total += data.length;
    if (total > MAX_BYTES || statSync(f.path).size > MAX_BYTES) throw new Error("That folder is too big to zip.");
    const packed = deflateRawSync(data);
    const useDeflate = packed.length < data.length;
    const body = useDeflate ? packed : data;
    const method = useDeflate ? 8 : 0;
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // names are UTF-8
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, name, body);
    const entry = Buffer.alloc(46);
    entry.writeUInt32LE(0x02014b50, 0);
    entry.writeUInt16LE(20, 4);
    entry.writeUInt16LE(20, 6);
    entry.writeUInt16LE(0x0800, 8);
    entry.writeUInt16LE(method, 10);
    entry.writeUInt16LE(time, 12);
    entry.writeUInt16LE(date, 14);
    entry.writeUInt32LE(crc, 16);
    entry.writeUInt32LE(body.length, 20);
    entry.writeUInt32LE(data.length, 24);
    entry.writeUInt16LE(name.length, 28);
    entry.writeUInt32LE(offset, 42);
    central.push(entry, name);
    offset += local.length + name.length + body.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}
