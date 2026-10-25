import { loadConfig } from "@friend/server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IO } from "./cli";
import { configCommand, configKeys } from "./commands/config";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), "friend-webcfg-"));
  const i: IO = { dataDir, out: (l) => out.push(l), err: (l) => err.push(l), ask: async () => "" };
  return { i, out, err, dataDir };
}
const set = async (t: ReturnType<typeof io>, k: string, v: string) => configCommand(["set", k, v], t.i);

describe("friend config set: searching the web and tidying the conversation", () => {
  it("lists the new keys", () => {
    for (const k of ["claudeCode.webSearch", "session.autoCompact", "session.compactAtTokens", "web.enabled", "web.provider", "web.searxngUrl", "web.braveKey", "web.tavilyKey"]) expect(configKeys(), k).toContain(k);
  });

  it("saves them", async () => {
    const t = io();
    expect(await set(t, "claudeCode.webSearch", "false")).toBe(0);
    expect(await set(t, "session.autoCompact", "false")).toBe(0);
    expect(await set(t, "session.compactAtTokens", "200000")).toBe(0);
    expect(await set(t, "web.enabled", "false")).toBe(0);
    expect(await set(t, "web.provider", "searxng")).toBe(0);
    expect(await set(t, "web.searxngUrl", "http://localhost:8080")).toBe(0);
    expect(await set(t, "web.braveKey", "BK")).toBe(0);
    expect(await set(t, "web.tavilyKey", "TK")).toBe(0);
    const c = loadConfig(t.dataDir);
    expect(c.claudeCode.webSearch).toBe(false);
    expect(c.session).toEqual({ autoCompact: false, compactAtTokens: 200_000 });
    expect(c.web).toEqual({ enabled: false, provider: "searxng", searxngUrl: "http://localhost:8080", braveKey: "BK", tavilyKey: "TK", tavily: { installed: false, enabled: false, depth: "basic", maxResults: 5 } });
  });

  it("refuses values that make no sense", async () => {
    const t = io();
    await expect(set(t, "web.provider", "google")).rejects.toThrow();
    await expect(set(t, "web.searxngUrl", "ftp://x")).rejects.toThrow();
    await expect(set(t, "session.compactAtTokens", "10")).rejects.toThrow();
    await expect(set(t, "session.compactAtTokens", "99999999")).rejects.toThrow();
    await expect(set(t, "session.autoCompact", "maybe")).rejects.toThrow();
    await expect(set(t, "web.enabled", "perhaps")).rejects.toThrow();
  });

  it("lets an address be cleared, and never prints a key", async () => {
    const t = io();
    await set(t, "web.searxngUrl", "http://localhost:8080");
    await set(t, "web.searxngUrl", "");
    expect(loadConfig(t.dataDir).web.searxngUrl).toBe("");
    await set(t, "web.braveKey", "SECRET-KEY-123");
    expect(t.out.join("\n")).not.toContain("SECRET-KEY-123");
  });
});
