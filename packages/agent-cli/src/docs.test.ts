import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { USAGE, run, type IO } from "./cli";
import { KEY_HELP, configKeys } from "./commands/config";
import { STEP_IDS } from "./commands/onboard";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "../../..");
const readme = readFileSync(join(repo, "README.md"), "utf8");
const section = readme.slice(readme.indexOf("## Command reference"), readme.indexOf("## Quick start (from the source code)"));

/** What a command prints when it is asked for nothing or for something it does not know. */
async function helpOf(cmd: string): Promise<string> {
  const out: string[] = [];
  const io: IO = { dataDir: mkdtempSync(join(tmpdir(), "friend-docs-")), out: (s) => out.push(s), err: (s) => out.push(s), ask: async () => "" };
  await run([cmd, "?"], io);
  return out.join("\n");
}

describe("the README's command reference", () => {
  it("exists", () => {
    expect(section.length).toBeGreaterThan(2000);
  });

  it("covers every command in the program's own help", () => {
    const names = USAGE.split("\n")
      .filter((l) => /^ {2}[a-z]/.test(l))
      .map((l) => l.trim().split(/\s+/)[0]!);
    expect(names.length).toBeGreaterThanOrEqual(15);
    for (const n of names) expect(section, `friend ${n}`).toContain(`friend ${n}`);
  });

  it("covers every subcommand each command says it has", async () => {
    const cmds = ["ollama", "claude", "voice", "memory", "plugin", "rules", "devices", "lan", "config"];
    for (const cmd of cmds) {
      const usage = (await helpOf(cmd)).split("\n").find((l) => l.startsWith("Usage:"));
      expect(usage, `${cmd} has a usage line`).toBeTruthy();
      const parts = usage!.replace(/^Usage:\s*/, "").split("|");
      for (const part of parts) {
        const words = part.trim().replace(new RegExp(`^friend ${cmd} `), "").replace(new RegExp(`^friend `), "").split(/\s+/);
        const sub = words[0]!;
        if (!/^[a-z]+$/.test(sub) || sub === cmd) continue;
        expect(section, `friend ${cmd} ${sub}`).toContain(`friend ${cmd} ${sub}`);
      }
    }
  });

  it("covers the options of the setup wizard and every step name", () => {
    for (const flag of ["--no-install", "--yes", "--redo", "--reset"]) expect(section, flag).toContain(flag);
    for (const step of STEP_IDS) expect(section, step).toContain(step);
  });

  it("covers the options of the commands that have them", () => {
    for (const x of ["--female", "--male", "--voice", "--port", "--use", "--roots", "--name", "--yes"]) expect(section, x).toContain(x);
  });

  it("lists every setting, and the program can say what each one is", () => {
    for (const k of configKeys()) {
      expect(section, k).toContain(`\`${k}\``);
      expect(KEY_HELP[k], `help for ${k}`).toBeTruthy();
    }
    expect(Object.keys(KEY_HELP).sort()).toEqual([...configKeys()].sort());
  });

  it("friend config keys prints them all", async () => {
    const out: string[] = [];
    const io: IO = { dataDir: mkdtempSync(join(tmpdir(), "friend-docs-")), out: (s) => out.push(s), err: (s) => out.push(s), ask: async () => "" };
    expect(await run(["config", "keys"], io)).toBe(0);
    expect(out).toHaveLength(configKeys().length);
    for (const k of configKeys()) expect(out.join("\n")).toContain(k);
  });

  it("lists every environment variable the program reads", () => {
    const found = new Set<string>();
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) {
          if (!["node_modules", "dist", ".venv", "testing"].includes(e.name)) walk(p);
        } else if (/\.(ts|tsx|mjs)$/.test(e.name) && !/\.test\./.test(e.name)) {
          for (const m of readFileSync(p, "utf8").matchAll(/(?<!_)FRIEND_[A-Z]+(?:_[A-Z]+)*/g)) found.add(m[0]);
        }
      }
    };
    walk(join(repo, "packages"));
    walk(join(repo, "scripts"));
    found.delete("FRIEND_VOICE_TOKEN"); // handed to the speech engine by Friend itself
    expect(found.size).toBeGreaterThanOrEqual(6);
    for (const v of found) expect(section, v).toContain(v);
  });

  it("lists every command of the message bar", () => {
    const web = readFileSync(join(repo, "packages/web/src/input/appCommands.ts"), "utf8");
    const names = [...web.matchAll(/name: "([a-z]+)"/g)].map((m) => m[1]!);
    expect(names.length).toBeGreaterThanOrEqual(14);
    for (const n of names) expect(section, `/${n}`).toContain(`/${n}`);
  });

  it("says how many voices there are, and names the female and male default", () => {
    expect(section).toMatch(/twelve voices \(six female, six male\)/);
    expect(section).toMatch(/Amy/);
    expect(section).toMatch(/Ryan/);
  });
});
