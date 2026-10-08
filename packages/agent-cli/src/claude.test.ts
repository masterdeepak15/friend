import { loadConfig } from "@friend/server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IO } from "./cli";
import { claudeCommand } from "./commands/claude";
import { configCommand } from "./commands/config";
import type { Runner } from "./commands/voice";

function io() {
  const out: string[] = [];
  const err: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), "friend-claudecli-"));
  const i: IO = { dataDir, out: (l) => out.push(l), err: (l) => err.push(l), ask: async () => "" };
  return { i, out, err, dataDir };
}
const runner = (opts: { installed?: boolean; signedIn?: boolean }): Runner => async (_cmd, args) => {
  if (opts.installed === false) return { code: 1, stdout: "" };
  if (args[0] === "--version") return { code: 0, stdout: "2.1.294 (Claude Code)\n" };
  return opts.signedIn === false
    ? { code: 1, stdout: JSON.stringify({ loggedIn: false }) }
    : { code: 0, stdout: JSON.stringify({ loggedIn: true, email: "me@example.com" }) };
};

describe("friend claude", () => {
  it("setup says what to do when Claude Code is missing, and changes nothing", async () => {
    const t = io();
    expect(await claudeCommand(["setup", "--use"], t.i, { run: runner({ installed: false }) })).toBe(1);
    expect(t.err.join("\n")).toMatch(/not installed/);
    expect(loadConfig(t.dataDir).provider).not.toBe("claude-code");
  });

  it("setup says what to do when Claude Code is not signed in, and changes nothing", async () => {
    const t = io();
    expect(await claudeCommand(["setup", "--use"], t.i, { run: runner({ signedIn: false }) })).toBe(1);
    expect(t.err.join("\n")).toMatch(/not signed in/);
    expect(loadConfig(t.dataDir).provider).not.toBe("claude-code");
  });

  it("setup only checks unless asked to switch", async () => {
    const t = io();
    expect(await claudeCommand(["setup"], t.i, { run: runner({}) })).toBe(0);
    expect(t.out.join("\n")).toMatch(/signed in/);
    expect(loadConfig(t.dataDir).provider).not.toBe("claude-code");
  });

  it("setup --use switches the provider", async () => {
    const t = io();
    expect(await claudeCommand(["setup", "--use"], t.i, { run: runner({}) })).toBe(0);
    expect(loadConfig(t.dataDir).provider).toBe("claude-code");
  });

  it("status reports the state in each case", async () => {
    for (const [opts, expected] of [
      [{ installed: false }, /not found/],
      [{ signedIn: false }, /Signed in:\s+no/],
      [{}, /Signed in:\s+yes/],
    ] as const) {
      const t = io();
      expect(await claudeCommand(["status"], t.i, { run: runner(opts) })).toBe(0);
      expect(t.out.join("\n")).toMatch(expected);
    }
  });

  it("shows usage for anything else", async () => {
    const t = io();
    expect(await claudeCommand([], t.i, { run: runner({}) })).toBe(1);
    expect(t.err.join("\n")).toMatch(/Usage/);
  });
});

describe("friend config set for Claude Code", () => {
  it("accepts the provider and the claudeCode settings", async () => {
    const t = io();
    for (const [k, v] of [["provider", "claude-code"], ["claudeCode.model", "haiku"], ["claudeCode.fallback", "none"], ["claudeCode.command", "C:/tools/claude.exe"]]) {
      expect(await configCommand(["set", k!, v!], t.i)).toBe(0);
    }
    const c = loadConfig(t.dataDir);
    expect(c.provider).toBe("claude-code");
    expect(c.claudeCode).toEqual({ model: "haiku", command: "C:/tools/claude.exe", fallback: "none" });
  });

  it("refuses values that make no sense", async () => {
    const t = io();
    await expect(configCommand(["set", "claudeCode.fallback", "maybe"], t.i)).rejects.toThrow();
    await expect(configCommand(["set", "claudeCode.model", "sonnet --dangerously-skip-permissions"], t.i)).rejects.toThrow();
    await expect(configCommand(["set", "provider", "gpt"], t.i)).rejects.toThrow();
  });
});
