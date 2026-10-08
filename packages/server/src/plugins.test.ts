import { existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "./db";
import { MAX_SKILL_BYTES, MAX_TOOL_BYTES, Plugins } from "./plugins";

const tmp = (p: string) => mkdtempSync(join(tmpdir(), p));
let home: string;
let src: string;
let plugins: Plugins;

const manifest = (over: Record<string, unknown> = {}) => ({
  id: "unit-converter",
  name: "Unit converter",
  version: "1.0.0",
  description: "Converts units",
  skills: [{ name: "standup", description: "Write a stand-up update", file: "skills/standup.md" }],
  tools: [
    {
      name: "convert",
      description: "Convert a value between units",
      language: "python",
      file: "tools/convert.py",
      input: { value: { type: "number" }, from: { type: "string" }, to: { type: "string", enum: ["km", "mi"] }, precise: { type: "boolean" } },
      required: ["value", "from", "to"],
    },
  ],
  ...over,
});

/** Writes a plugin folder; `files` overrides or adds files, `null` removes one. */
function make(over: Record<string, unknown> = {}, files: Record<string, string | null> = {}): string {
  const dir = tmp("friend-plugsrc-");
  const all: Record<string, string | null> = {
    "plugin.json": JSON.stringify(manifest(over)),
    "skills/standup.md": "Ask what was done, what is next, and what blocks.",
    "tools/convert.py": "import json; print(json.load(open('/work/args.json')))",
    ...files,
  };
  for (const [rel, body] of Object.entries(all)) {
    if (body === null) continue;
    mkdirSync(dirname(join(dir, rel)), { recursive: true });
    writeFileSync(join(dir, rel), body);
  }
  return dir;
}

beforeEach(() => {
  home = tmp("friend-plughome-");
  src = make();
  plugins = new Plugins(openDb(tmp("friend-plugdb-")), join(home, "plugins"));
});

describe("install, list, enable, remove", () => {
  it("installs a valid plugin and lists what is in it", () => {
    expect(plugins.install(src)).toEqual({ ok: true, id: "unit-converter", upgraded: false });
    const [p] = plugins.list();
    expect(p).toMatchObject({ id: "unit-converter", name: "Unit converter", version: "1.0.0", enabled: true, error: null });
    expect(p!.skills.map((s) => s.name)).toEqual(["standup"]);
    expect(p!.tools.map((t) => t.name)).toEqual(["convert"]);
    expect(existsSync(join(home, "plugins", "unit-converter", "tools", "convert.py"))).toBe(true);
  });

  it("an upgrade replaces the files and keeps the on/off choice", () => {
    plugins.install(src);
    plugins.setEnabled("unit-converter", false);
    const v2 = make({ version: "2.0.0" }, { "skills/standup.md": "new text" });
    expect(plugins.install(v2)).toEqual({ ok: true, id: "unit-converter", upgraded: true });
    expect(plugins.list()[0]).toMatchObject({ version: "2.0.0", enabled: false });
    plugins.setEnabled("unit-converter", true);
    expect(plugins.skillText("unit-converter", "standup")).toBe("new text");
  });

  it("switching off hides its skills and tools; switching on brings them back", () => {
    plugins.install(src);
    expect(plugins.skills()).toHaveLength(1);
    expect(plugins.toolDefs()).toHaveLength(1);
    expect(plugins.setEnabled("unit-converter", false)).toBe(true);
    expect(plugins.skills()).toEqual([]);
    expect(plugins.toolDefs()).toEqual([]);
    expect(plugins.skillText("unit-converter", "standup")).toBeNull();
    plugins.setEnabled("unit-converter", true);
    expect(plugins.toolDefs()).toHaveLength(1);
    expect(plugins.setEnabled("nope", true)).toBe(false);
  });

  it("removes the files and the record", () => {
    plugins.install(src);
    expect(plugins.remove("unit-converter")).toBe(true);
    expect(plugins.list()).toEqual([]);
    expect(existsSync(join(home, "plugins", "unit-converter"))).toBe(false);
    expect(plugins.remove("unit-converter")).toBe(false);
  });

  it("does not leave a half-installed plugin when the new one is invalid", () => {
    plugins.install(src);
    const bad = make({ version: "3.0.0" }, { "tools/convert.py": null });
    expect(plugins.install(bad).ok).toBe(false);
    expect(plugins.list()[0]).toMatchObject({ version: "1.0.0", error: null });
  });
});

describe("what a plugin may contain", () => {
  const refuses = (over: Record<string, unknown>, files: Record<string, string | null>, message: RegExp) => {
    const r = plugins.install(make(over, files));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toMatch(message);
    expect(plugins.list()).toEqual([]);
  };

  it.each([
    ["Upper"],
    ["has_underscore"],
    ["double--hyphen"],
    ["-leading"],
    ["trailing-"],
    ["a__b"],
    ["x".repeat(41)],
    [""],
  ])("refuses the id %j", (id) => refuses({ id }, {}, /id/i));

  it("refuses names that could clash with tool-name encoding or each other", () => {
    refuses({ tools: [{ ...manifest().tools[0]!, name: "bad__name" }] }, {}, /name/i);
    const t = manifest().tools[0]!;
    refuses({ tools: [t, t] }, {}, /twice|duplicate/i);
    const s = manifest().skills[0]!;
    refuses({ skills: [s, s] }, {}, /twice|duplicate/i);
  });

  it("refuses unknown manifest keys, bad JSON and a missing manifest", () => {
    refuses({ permissions: ["network"] }, {}, /plugin\.json/i);
    refuses({}, { "plugin.json": "{ not json" }, /plugin\.json/i);
    refuses({}, { "plugin.json": null }, /plugin\.json/i);
  });

  it("refuses too many skills or tools", () => {
    const skills = Array.from({ length: 11 }, (_, i) => ({ name: `s${i}`, description: "d", file: "skills/standup.md" }));
    refuses({ skills }, {}, /at most 10/i);
    const tools = Array.from({ length: 11 }, (_, i) => ({ ...manifest().tools[0]!, name: `t${i}` }));
    refuses({ tools }, {}, /at most 10/i);
  });

  it("refuses files outside the plugin folder, absolute paths and missing files", () => {
    for (const file of ["../outside.md", "skills/../../x.md", "/etc/passwd", "C:\\Windows\\win.ini", "skills\\..\\..\\x"]) {
      refuses({ skills: [{ name: "x", description: "d", file }] }, {}, /inside the plugin/i);
    }
    refuses({ skills: [{ name: "x", description: "d", file: "skills/missing.md" }] }, {}, /missing\.md/);
  });

  it("refuses oversize skill and tool files", () => {
    refuses({}, { "skills/standup.md": "x".repeat(MAX_SKILL_BYTES + 1) }, /too large/i);
    refuses({}, { "tools/convert.py": "x".repeat(MAX_TOOL_BYTES + 1) }, /too large/i);
  });

  it("refuses a plugin with too many files or too much data", () => {
    const many: Record<string, string> = {};
    for (let i = 0; i < 60; i++) many[`extra/f${i}.txt`] = "x";
    refuses({}, many, /at most 50 files/i);
    const big: Record<string, string> = {};
    for (let i = 0; i < 6; i++) big[`data/d${i}.bin`] = "x".repeat(200_000);
    refuses({}, big, /1 MB/i);
  });

  it("refuses a symbolic link anywhere in the plugin", () => {
    const dir = make();
    try {
      symlinkSync(join(dir, "plugin.json"), join(dir, "link.md"));
    } catch {
      return; // creating links needs a privilege on some systems: nothing to test there
    }
    const r = plugins.install(dir);
    expect(r.ok === false && r.error).toMatch(/link/i);
  });

  it("refuses bad tool input declarations", () => {
    const t = manifest().tools[0]!;
    refuses({ tools: [{ ...t, input: { value: { type: "object" } }, required: [] }] }, {}, /type/i);
    refuses({ tools: [{ ...t, required: ["ghost"] }] }, {}, /required.*ghost|ghost/i);
    refuses({ tools: [{ ...t, input: { "bad name": { type: "string" } }, required: [] }] }, {}, /property/i);
    refuses({ tools: [{ ...t, language: "ruby" }] }, {}, /language/i);
  });
});

describe("a plugin that breaks after it was installed", () => {
  it("is switched off with a reason, and never throws", () => {
    plugins.install(src);
    rmSync(join(home, "plugins", "unit-converter", "tools", "convert.py"));
    const fresh = new Plugins(openDb(tmp("friend-plugdb-")), join(home, "plugins"));
    expect(() => plugins.reload()).not.toThrow();
    expect(plugins.list()[0]!.error).toMatch(/convert\.py/);
    expect(plugins.toolDefs()).toEqual([]);
    expect(plugins.skills()).toEqual([]);
    expect(fresh.list()).toEqual([]);
  });

  it("an edited manifest is validated again on load", () => {
    plugins.install(src);
    writeFileSync(join(home, "plugins", "unit-converter", "plugin.json"), JSON.stringify(manifest({ id: "Evil Id" })));
    plugins.reload();
    expect(plugins.list()[0]!.error).toBeTruthy();
    expect(plugins.toolDefs()).toEqual([]);
  });
});

describe("what the agent gets", () => {
  beforeEach(() => void plugins.install(src));

  it("lists skills by plugin, name and description, and returns the text on request", () => {
    expect(plugins.skills()).toEqual([{ plugin: "unit-converter", name: "standup", description: "Write a stand-up update" }]);
    expect(plugins.skillText("unit-converter", "standup")).toBe("Ask what was done, what is next, and what blocks.");
    expect(plugins.skillText("unit-converter", "nope")).toBeNull();
    expect(plugins.skillText("nope", "standup")).toBeNull();
  });

  it("exposes tools as plugin.<id>.<name> with a JSON schema and a strict argument check", () => {
    const [t] = plugins.toolDefs();
    expect(t).toMatchObject({ name: "plugin.unit-converter.convert", pluginId: "unit-converter", toolName: "convert", language: "python" });
    expect(t!.inputSchema).toEqual({
      type: "object",
      properties: {
        value: { type: "number" },
        from: { type: "string" },
        to: { type: "string", enum: ["km", "mi"] },
        precise: { type: "boolean" },
      },
      required: ["value", "from", "to"],
      additionalProperties: false,
    });
    expect(t!.input.safeParse({ value: 5, from: "km", to: "mi" }).success).toBe(true);
    expect(t!.input.safeParse({ value: 5, from: "km", to: "mi", precise: true }).success).toBe(true);
    expect(t!.input.safeParse({ value: "5", from: "km", to: "mi" }).success).toBe(false); // wrong type
    expect(t!.input.safeParse({ value: 5, from: "km", to: "ft" }).success).toBe(false); // not in the enum
    expect(t!.input.safeParse({ value: 5, from: "km" }).success).toBe(false); // missing required
    expect(t!.input.safeParse({ value: 5, from: "km", to: "mi", extra: 1 }).success).toBe(false); // unknown property
    expect(t!.input.safeParse({ value: Number.POSITIVE_INFINITY, from: "km", to: "mi" }).success).toBe(false);
  });

  it("hands over the program text and finds a tool by its full name", () => {
    const t = plugins.tool("plugin.unit-converter.convert")!;
    expect(t.code).toContain("args.json");
    expect(plugins.tool("plugin.unit-converter.nope")).toBeUndefined();
    expect(plugins.tool("fs.read")).toBeUndefined();
  });
});
