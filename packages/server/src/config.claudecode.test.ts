import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_CLAUDE_CODE, loadConfig } from "./config";

const fresh = () => mkdtempSync(join(tmpdir(), "friend-cfgcc-"));
const withConfig = (cfg: unknown) => {
  const dir = fresh();
  loadConfig(dir);
  writeFileSync(join(dir, "config.json"), JSON.stringify(cfg));
  return loadConfig(dir);
};

describe("claudeCode settings", () => {
  it("default to a good model, the plain command, and Ollama as the safety net", () => {
    expect(DEFAULT_CLAUDE_CODE).toEqual({ model: "sonnet", command: "claude", fallback: "ollama", webSearch: true });
    expect(loadConfig(fresh()).claudeCode).toEqual(DEFAULT_CLAUDE_CODE);
  });

  it("keeps what was set and fills in the rest", () => {
    expect(withConfig({ claudeCode: { model: "haiku" } }).claudeCode).toEqual({ model: "haiku", command: "claude", fallback: "ollama", webSearch: true });
    expect(withConfig({ claudeCode: { fallback: "none", command: "C:/tools/claude.exe" } }).claudeCode).toEqual({ model: "sonnet", command: "C:/tools/claude.exe", fallback: "none", webSearch: true });
  });

  it("fall back to the defaults for values that make no sense", () => {
    expect(withConfig({ claudeCode: { model: "", command: "  ", fallback: "everything" } }).claudeCode).toEqual(DEFAULT_CLAUDE_CODE);
    expect(withConfig({ claudeCode: { model: 5, command: null, fallback: 7 } }).claudeCode).toEqual(DEFAULT_CLAUDE_CODE);
    expect(withConfig({ claudeCode: "nonsense" }).claudeCode).toEqual(DEFAULT_CLAUDE_CODE);
  });

  it("do not let a model or command name carry extra arguments", () => {
    expect(withConfig({ claudeCode: { model: "sonnet --dangerously-skip-permissions" } }).claudeCode.model).toBe("sonnet");
    expect(withConfig({ claudeCode: { command: "claude && del *" } }).claudeCode.command).toBe("claude");
    expect(withConfig({ claudeCode: { model: "claude-sonnet-5-5" } }).claudeCode.model).toBe("claude-sonnet-5-5");
  });

  it("accept claude-code as the provider", () => {
    expect(withConfig({ provider: "claude-code" }).provider).toBe("claude-code");
  });

  it("lets Claude search the web unless it is switched off", () => {
    expect(withConfig({}).claudeCode.webSearch).toBe(true);
    expect(withConfig({ claudeCode: { webSearch: false } }).claudeCode.webSearch).toBe(false);
    expect(withConfig({ claudeCode: { webSearch: "no" } }).claudeCode.webSearch).toBe(true);
  });
});
