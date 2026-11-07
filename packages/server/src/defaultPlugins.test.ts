import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { installDefaults } from "./defaultPlugins";

const setup = (ids: string[] = ["screen-design"]) => {
  const dir = mkdtempSync(join(tmpdir(), "friend-defaults-"));
  const catalog = join(dir, "catalog");
  for (const id of ids) {
    mkdirSync(join(catalog, id, "skills"), { recursive: true });
    writeFileSync(join(catalog, id, "plugin.json"), JSON.stringify({ id, name: id, version: "1.0.0", description: "d", skills: [{ name: "s", description: "d", file: "skills/s.md" }] }));
    writeFileSync(join(catalog, id, "skills", "s.md"), "# s some text");
  }
  const installed: string[] = [];
  const have: string[] = [];
  const plugins = {
    install: (src: string) => {
      installed.push(src.split(/[\\/]/).pop()!);
      return { ok: true as const, id: src.split(/[\\/]/).pop()!, upgraded: false };
    },
    list: () => have.map((id) => ({ id })) as { id: string }[],
  };
  return { dir, catalog, installed, have, plugins };
};

describe("installDefaults", () => {
  it("installs a default plugin the first time and says so", () => {
    const s = setup();
    expect(installDefaults(s.plugins, s.catalog, s.dir, ["screen-design"])).toEqual(["screen-design"]);
    expect(s.installed).toEqual(["screen-design"]);
  });
  it("does not install it again after the owner removed it", () => {
    const s = setup();
    installDefaults(s.plugins, s.catalog, s.dir, ["screen-design"]);
    s.installed.length = 0; // the owner removed it; it is not in the list
    expect(installDefaults(s.plugins, s.catalog, s.dir, ["screen-design"])).toEqual([]);
    expect(s.installed).toEqual([]);
  });
  it("leaves one that is already installed alone but remembers it was offered", () => {
    const s = setup();
    s.have.push("screen-design");
    expect(installDefaults(s.plugins, s.catalog, s.dir, ["screen-design"])).toEqual([]);
    expect(JSON.parse(readFileSync(join(s.dir, "default-plugins.json"), "utf8"))).toEqual({ offered: ["screen-design"] });
  });
  it("skips one that is not in the catalog without remembering it, so a later build can offer it", () => {
    const s = setup([]);
    expect(installDefaults(s.plugins, s.catalog, s.dir, ["screen-design"])).toEqual([]);
    expect(() => readFileSync(join(s.dir, "default-plugins.json"))).toThrow();
  });
  it("survives a broken marker file", () => {
    const s = setup();
    writeFileSync(join(s.dir, "default-plugins.json"), "not json");
    expect(installDefaults(s.plugins, s.catalog, s.dir, ["screen-design"])).toEqual(["screen-design"]);
  });
});
