import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = dirname(fileURLToPath(import.meta.url));
const read = (p: string) => JSON.parse(readFileSync(resolve(here, p), "utf8")) as Record<string, any>;
const pkg = read("package.json");

describe("the npm package", () => {
  it("is a public package with a friend command for Node 20 and up", () => {
    expect(pkg.name).toBe("friend-assistant");
    expect(pkg.private).toBeUndefined();
    expect(pkg.version).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.bin).toEqual({ friend: "bin/friend.js" });
    expect(pkg.engines.node).toBe(">=20");
    expect(pkg.publishConfig).toEqual({ access: "public" });
    expect(pkg.type).toBe("module");
  });

  it("publishes only the program, the files it needs and the readme", () => {
    expect(pkg.files).toEqual(["bin", "dist", "README.md"]);
    for (const f of pkg.files as string[]) expect(f).not.toMatch(/src|test|node_modules|\.\./);
  });

  it("depends on exactly what the program imports from npm, at the same versions as the workspace", () => {
    const used: Record<string, string> = {};
    for (const p of ["../server/package.json", "../agent-cli/package.json", "../protocol/package.json"]) {
      for (const [name, range] of Object.entries(read(p).dependencies ?? {})) {
        if (name.startsWith("@friend/")) continue;
        if (used[name] && used[name] !== range) throw new Error(`${name} has two different versions in the workspace`);
        used[name] = range as string;
      }
    }
    expect(pkg.dependencies).toEqual(used);
  });

  it("checks the Node version before loading anything, then loads the program", () => {
    const bin = readFileSync(resolve(here, "bin/friend.js"), "utf8");
    expect(bin.startsWith("#!/usr/bin/env node")).toBe(true);
    expect(bin.indexOf("major < 20")).toBeGreaterThan(-1);
    expect(bin.indexOf("major < 20")).toBeLessThan(bin.indexOf('import("../dist/friend.mjs")'));
  });

  it("bundles our own code and leaves the npm packages as dependencies", () => {
    const script = readFileSync(resolve(here, "scripts/bundle.mjs"), "utf8");
    expect(script).toContain("external: Object.keys(pkg.dependencies)");
    expect(script).toContain("__FRIEND_VERSION__");
    for (const asset of ["web", "plugins", "voice/friend_voice"]) expect(script).toContain(asset);
  });

  it("carries Chrome control inside, bundled with what it needs, so nothing else has to be installed", () => {
    const script = readFileSync(resolve(here, "scripts/bundle.mjs"), "utf8");
    for (const part of ["packages/chrome-control", "src/index.ts", "src/native-host.ts", "chrome-control", "extension"]) expect(script).toContain(part);
    expect(script).not.toMatch(/external:.*chrome/);
  });

  // only when the package has been built (pnpm package)
  const bundle = resolve(here, "dist/friend.mjs");
  const built = existsSync(bundle);

  it.skipIf(!built)("the built program carries no paths or secrets from the machine that built it", () => {
    const js = readFileSync(bundle, "utf8");
    expect(js).not.toMatch(/[A-Z]:\\\\(Users|ClaudeWorkspace)|\/home\/[a-z]+\/|\/Users\/[A-Za-z]+\//);
    expect(js).not.toMatch(/sk-ant-[A-Za-z0-9_-]{10,}/);
    expect(js).not.toContain("masterdeepak15@");
  });

  it.skipIf(!built)("the built package holds the web app, the plugins and the Python voice code next to the program", () => {
    for (const f of ["web/index.html", "plugins/unit-converter/plugin.json", "voice/friend_voice/__main__.py", "BUILD.json"]) expect(existsSync(join(here, "dist", f)), f).toBe(true);
    expect(existsSync(join(here, "dist/voice/friend_voice/__pycache__"))).toBe(false);
    expect(JSON.parse(readFileSync(join(here, "dist/BUILD.json"), "utf8")).version).toBe(pkg.version);
  });

  it.skipIf(!built)("the built package holds Chrome control next to the program, laid out the way its own setup expects", () => {
    const base = join(here, "dist", "chrome-control");
    for (const f of ["dist/index.js", "dist/native-host.js", "extension/manifest.json", "package.json", "LICENSE"]) expect(existsSync(join(base, f)), f).toBe(true);
    expect(JSON.parse(readFileSync(join(base, "package.json"), "utf8")).version).toMatch(/^\d+\.\d+\.\d+$/);
    const js = readFileSync(join(base, "dist", "index.js"), "utf8");
    expect(js).not.toMatch(/[A-Z]:\\(Users|ClaudeWorkspace)|\/home\/[a-z]+\/|\/Users\/[A-Za-z]+\//);
    expect(js).not.toMatch(/^import [^\n]* from ["'](ws|zod|@modelcontextprotocol\/[^"']*)["']/m); // bundled in, not left to be installed
  });

  it.skipIf(!built)("the built program imports no workspace package and no source files", () => {
    const js = readFileSync(bundle, "utf8");
    expect(js).not.toMatch(/from ["']@friend\//);
    expect(js).not.toMatch(/from ["']\.\.?\/[^"']*\.tsx?["']/);
  });
});
