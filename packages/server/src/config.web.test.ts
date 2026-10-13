import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_WEB, loadConfig, sanitizeWeb } from "./config";

const withConfig = (cfg: unknown) => {
  const dir = mkdtempSync(join(tmpdir(), "friend-cfgweb-"));
  loadConfig(dir);
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
  return loadConfig(dir);
};

describe("web settings", () => {
  it("default to searching on, with DuckDuckGo and no keys", () => {
    expect(DEFAULT_WEB).toEqual({ enabled: true, provider: "duckduckgo", searxngUrl: "", braveKey: null, tavilyKey: null });
    expect(withConfig({}).web).toEqual(DEFAULT_WEB);
  });

  it("keep what was saved", () => {
    const w = withConfig({ web: { enabled: false, provider: "brave", braveKey: "BK", searxngUrl: "http://localhost:8080" } }).web;
    expect(w).toEqual({ enabled: false, provider: "brave", searxngUrl: "http://localhost:8080", braveKey: "BK", tavilyKey: null });
  });

  it("turn nonsense into the defaults", () => {
    expect(sanitizeWeb({ enabled: "yes", provider: "google", searxngUrl: 5, braveKey: 7, tavilyKey: {} })).toEqual(DEFAULT_WEB);
    expect(sanitizeWeb(undefined)).toEqual(DEFAULT_WEB);
    expect(sanitizeWeb(null)).toEqual(DEFAULT_WEB);
  });

  it("only take a SearXNG address that is a web address", () => {
    expect(sanitizeWeb({ searxngUrl: "http://localhost:8080/" }).searxngUrl).toBe("http://localhost:8080/");
    expect(sanitizeWeb({ searxngUrl: "https://search.example.com" }).searxngUrl).toBe("https://search.example.com");
    for (const bad of ["ftp://x", "javascript:alert(1)", "file:///C:/x", "not a url", "http://user:pw@host/"]) expect(sanitizeWeb({ searxngUrl: bad }).searxngUrl, bad).toBe("");
  });

  it("treat an empty or blank key as no key", () => {
    expect(sanitizeWeb({ braveKey: "   ", tavilyKey: "" })).toMatchObject({ braveKey: null, tavilyKey: null });
    expect(sanitizeWeb({ braveKey: " KEY " }).braveKey).toBe("KEY");
    expect(sanitizeWeb({ braveKey: "x".repeat(500) }).braveKey).toBeNull();
  });
});
