import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));

type Target = { base: string; label: string; local: boolean } | null;

/** The extension's own parseTarget, taken out of background.js (a service worker script, so it cannot be imported). */
function load(): (c: { host?: string; port?: number }) => Target {
  const src = readFileSync(join(here, "extension", "background.js"), "utf8");
  const set = /const LOCAL_HOSTS = [^\n]+/.exec(src)?.[0];
  const start = src.indexOf("function parseTarget(c) {");
  const end = src.indexOf("\n}\n", start);
  if (!set || start < 0 || end < 0) throw new Error("parseTarget was not found in background.js");
  return new Function(`${set}\n${src.slice(start, end + 3)}\nreturn parseTarget;`)() as (c: { host?: string; port?: number }) => Target;
}
const parse = load();

describe("where the extension connects", () => {
  it("is this PC on the usual port when nothing is typed", () => {
    expect(parse({})).toEqual({ base: "ws://127.0.0.1:8765/", label: "127.0.0.1:8765", local: true });
  });
  it("takes a domain or IP and a port, as before", () => {
    expect(parse({ host: "192.168.1.5", port: 9000 })).toEqual({ base: "ws://192.168.1.5:9000/", label: "192.168.1.5:9000", local: false });
    expect(parse({ host: "wss://box.example.com" })).toEqual({ base: "wss://box.example.com:8765/", label: "box.example.com:8765", local: false });
  });
  it("takes an address with a path, so one Friend address and one port serve everything", () => {
    expect(parse({ host: "wss://friend.example.com/chrome/ws", port: 8765 })).toEqual({ base: "wss://friend.example.com/chrome/ws", label: "friend.example.com/chrome/ws", local: false });
    expect(parse({ host: "ws://192.168.1.5:8787/chrome/ws" })).toEqual({ base: "ws://192.168.1.5:8787/chrome/ws", label: "192.168.1.5:8787/chrome/ws", local: false });
  });
  it("keeps the path tidy: no double slashes, no query or fragment smuggled in", () => {
    expect(parse({ host: "wss://friend.example.com//chrome//ws/" })?.base).toBe("wss://friend.example.com/chrome/ws");
    expect(parse({ host: "wss://friend.example.com/chrome/ws?token=x" })).toBeNull();
    expect(parse({ host: "wss://friend.example.com/chrome/ws#x" })).toBeNull();
    expect(parse({ host: "wss://friend.example.com/a b" })).toBeNull();
  });
  it("still refuses what is not an address", () => {
    expect(parse({ host: "exa mple.com" })).toBeNull();
    expect(parse({ host: "http://example.com" })).toBeNull();
    expect(parse({ host: "wss://" , port: 1 })?.local).toBe(true); // empty means this PC
  });
  it("never counts an address with a path as this PC, even on a loopback name", () => {
    expect(parse({ host: "ws://127.0.0.1:8787/chrome/ws" })).toMatchObject({ base: "ws://127.0.0.1:8787/chrome/ws", local: false });
  });
});
