import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Plugins, openDb } from "@friend/server";
import { beforeEach, describe, expect, it } from "vitest";
import { run, type IO } from "./cli";
import { pluginCommand } from "./commands/plugin";

const catalogDir = resolve(dirname(fileURLToPath(import.meta.url)), "../../../plugins");
let dataDir: string;
let lines: string[];
let answer = "y";
const text = () => lines.join("\n");
const io = (): IO => ({ dataDir, out: (s) => lines.push(s), err: (s) => lines.push(s), ask: async () => answer });
const plugin = (args: string[]) => pluginCommand(args, io(), { catalogDir });
const installed = () => {
  const db = openDb(dataDir);
  try {
    return new Plugins(db, join(dataDir, "plugins")).list();
  } finally {
    db.close();
  }
};

function folder(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "friend-clipl-"));
  for (const [rel, body] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "friend-pluginscli-"));
  lines = [];
  answer = "y";
});

describe("friend plugin catalog / list", () => {
  it("lists the bundled plugins with what each one adds", async () => {
    expect(await plugin(["catalog"])).toBe(0);
    expect(text()).toMatch(/unit-converter.*Unit converter.*1 tool/s);
    expect(text()).toMatch(/standup-writer.*1 skill/s);
    expect(text()).toMatch(/rubber-duck/);
  });

  it("says when nothing is installed, then shows installed plugins with their state", async () => {
    expect(await plugin(["list"])).toBe(0);
    expect(text()).toMatch(/no plugins installed/i);
    await plugin(["install", "standup-writer", "--yes"]);
    lines = [];
    await plugin(["list"]);
    expect(text()).toMatch(/standup-writer.*1\.0\.0.*on/);
  });
});

describe("friend plugin install", () => {
  it("shows what is inside and installs after a yes", async () => {
    expect(await plugin(["install", "unit-converter"])).toBe(0);
    expect(text()).toMatch(/Unit converter/);
    expect(text()).toMatch(/Tools \(1\): convert/);
    expect(text()).toMatch(/Docker sandbox with no network/i);
    expect(text()).toMatch(/approval/i);
    expect(installed().map((p) => p.id)).toEqual(["unit-converter"]);
    expect(text()).toMatch(/Installed unit-converter/);
  });

  it("installs nothing after a no", async () => {
    answer = "n";
    expect(await plugin(["install", "unit-converter"])).toBe(1);
    expect(installed()).toEqual([]);
    expect(text()).toMatch(/not installed/i);
  });

  it("--yes skips the question", async () => {
    answer = "n";
    expect(await plugin(["install", "rubber-duck", "--yes"])).toBe(0);
    expect(installed()).toHaveLength(1);
  });

  it("installs from a folder on disk and reports an upgrade", async () => {
    const files = (version: string) => ({
      "plugin.json": JSON.stringify({ id: "mine", name: "Mine", version, skills: [{ name: "s", description: "d", file: "s.md" }] }),
      "s.md": "text",
    });
    expect(await plugin(["install", folder(files("1.0.0")), "--yes"])).toBe(0);
    lines = [];
    expect(await plugin(["install", folder(files("1.1.0")), "--yes"])).toBe(0);
    expect(text()).toMatch(/upgrade/i);
    expect(installed()[0]).toMatchObject({ id: "mine", version: "1.1.0" });
  });

  it("explains an invalid plugin and installs nothing", async () => {
    const bad = folder({ "plugin.json": JSON.stringify({ id: "Bad Id", name: "x", version: "1" }) });
    expect(await plugin(["install", bad, "--yes"])).toBe(1);
    expect(text()).toMatch(/cannot be installed.*id/is);
    expect(installed()).toEqual([]);
  });

  it("refuses an unknown name and a missing argument", async () => {
    expect(await plugin(["install", "no-such-plugin", "--yes"])).toBe(1);
    expect(text()).toMatch(/not in the catalog|no such folder/i);
    expect(await plugin(["install"])).toBe(1);
  });
});

describe("friend plugin enable / disable / remove", () => {
  beforeEach(async () => {
    await plugin(["install", "standup-writer", "--yes"]);
    lines = [];
  });

  it("switches a plugin off and on", async () => {
    expect(await plugin(["disable", "standup-writer"])).toBe(0);
    expect(installed()[0]!.enabled).toBe(false);
    expect(await plugin(["enable", "standup-writer"])).toBe(0);
    expect(installed()[0]!.enabled).toBe(true);
  });

  it("removes a plugin", async () => {
    expect(await plugin(["remove", "standup-writer"])).toBe(0);
    expect(installed()).toEqual([]);
  });

  it("reports an unknown plugin", async () => {
    for (const cmd of ["enable", "disable", "remove"]) expect(await plugin([cmd, "ghost"])).toBe(1);
    expect(text()).toMatch(/no plugin named ghost/i);
    expect(await plugin(["remove"])).toBe(1);
  });
});

describe("through the main command", () => {
  it("is reachable as friend plugin and shows usage for anything else", async () => {
    expect(await run(["plugin", "list"], io())).toBe(0);
    expect(await run(["plugin", "dance"], io())).toBe(1);
    expect(text()).toMatch(/usage: friend plugin/i);
  });
});
