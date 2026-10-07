import { existsSync, mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { TOOL_DEFS, describeCall } from "@friend/protocol";
import { resolveInRoots } from "./roots";
import { runTool, type ToolCtx } from "./index";

let root: string;
let ctx: ToolCtx;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "friend-tools-")));
  ctx = { roots: [root], timeoutMs: 10_000, maxOutput: 1000, allowOutside: false };
});

describe("resolveInRoots", () => {
  it("rejects .. traversal out of the root", () => {
    expect(resolveInRoots(join(root, "..", "..", "Windows"), [root]).inside).toBe(false);
    expect(resolveInRoots("..\\..\\Windows", [root]).inside).toBe(false);
  });
  it("accepts a nested path and a relative path", () => {
    expect(resolveInRoots(join(root, "a", "b.txt"), [root]).inside).toBe(true);
    expect(resolveInRoots("a/b.txt", [root]).inside).toBe(true);
  });
  it("is case-insensitive and separator-insensitive on Windows", () => {
    if (process.platform !== "win32") return;
    const upper = root.toUpperCase().replace(/\\/g, "/");
    expect(resolveInRoots(upper + "/file.txt", [root]).inside).toBe(true);
  });
  it("does not treat a sibling with a shared prefix as inside", () => {
    expect(resolveInRoots(root + "-evil", [root]).inside).toBe(false);
  });
  it("rejects a link inside the root that points outside", () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "friend-out-")));
    const link = join(root, "link");
    try {
      symlinkSync(outside, link, "junction");
    } catch {
      return; // cannot create links on this machine
    }
    expect(resolveInRoots(join(link, "x.txt"), [root]).inside).toBe(false);
  });
});

describe("runTool", () => {
  it("lists a directory", async () => {
    writeFileSync(join(root, "a.txt"), "hi");
    const r = await runTool("fs.list", { path: root }, ctx);
    expect(r.ok && r.output).toContain("a.txt");
  });
  it("reads a small file", async () => {
    writeFileSync(join(root, "a.txt"), "hello");
    const r = await runTool("fs.read", { path: join(root, "a.txt") }, ctx);
    expect(r).toEqual({ ok: true, output: "hello", truncated: false });
  });
  it("truncates a large file to maxOutput and flags it", async () => {
    writeFileSync(join(root, "big.txt"), "x".repeat(5 * 1024 * 1024));
    const r = await runTool("fs.read", { path: join(root, "big.txt") }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(true);
      expect(r.output.length).toBeLessThanOrEqual(1000);
    }
  });
  it("refuses a binary file with a clear error", async () => {
    writeFileSync(join(root, "b.bin"), Buffer.from([0, 1, 2, 0, 255, 0]));
    const r = await runTool("fs.read", { path: join(root, "b.bin") }, ctx);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/binary/i);
  });
  it("refuses reading outside the roots unless approved", async () => {
    const outside = realpathSync(mkdtempSync(join(tmpdir(), "friend-out-")));
    writeFileSync(join(outside, "s.txt"), "secret");
    const denied = await runTool("fs.read", { path: join(outside, "s.txt") }, ctx);
    expect(denied.ok).toBe(false);
    const allowed = await runTool("fs.read", { path: join(outside, "s.txt") }, { ...ctx, allowOutside: true });
    expect(allowed.ok && allowed.output).toBe("secret");
  });
  it("writes a file, creating parent folders", async () => {
    const p = join(root, "new", "dir", "f.txt");
    const r = await runTool("fs.write", { path: p, content: "data" }, ctx);
    expect(r.ok).toBe(true);
    expect(existsSync(p)).toBe(true);
  });
  it("runs a shell command and returns its output", async () => {
    const r = await runTool("shell.run", { command: "echo friend-ok", cwd: root }, ctx);
    expect(r.ok && r.output).toContain("friend-ok");
  });
  it("times out a slow command and kills it", async () => {
    mkdirSync(join(root, "w"), { recursive: true });
    const marker = join(root, "w", "marker.txt");
    const slow =
      process.platform === "win32"
        ? `Start-Sleep 2; Set-Content -Path '${marker}' -Value x`
        : `sleep 2; echo x > '${marker}'`;
    const r = await runTool("shell.run", { command: slow, cwd: root }, { ...ctx, timeoutMs: 300 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toMatch(/timed out/i);
    await new Promise((res) => setTimeout(res, 3000));
    expect(existsSync(marker)).toBe(false);
  }, 10_000);
  it("truncates and flags long shell output", async () => {
    const cmd = process.platform === "win32" ? "1..3000 | ForEach-Object { 'line' }" : "yes line | head -n 3000";
    const r = await runTool("shell.run", { command: cmd, cwd: root }, ctx);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.truncated).toBe(true);
      expect(r.output.length).toBeLessThanOrEqual(1000);
    }
  });
  it("returns an error for an unknown tool and for invalid arguments", async () => {
    expect((await runTool("nope.tool", {}, ctx)).ok).toBe(false);
    expect((await runTool("fs.read", { path: 42 }, ctx)).ok).toBe(false);
  });
  it("reports system info", async () => {
    const r = await runTool("system.info", {}, ctx);
    expect(r.ok && r.output).toMatch(/platform/i);
  });
});

describe("tool definitions", () => {
  it("describeCall shows the literal command for shell.run", () => {
    expect(describeCall("shell.run", { command: "dir C:\\" })).toContain("dir C:\\");
  });
  it("describeCall shows the path for fs.write", () => {
    expect(describeCall("fs.write", { path: "a.txt", content: "xyz" })).toContain("a.txt");
  });
  it("defines every Phase 1 tool with a tier and target", () => {
    const names = TOOL_DEFS.map((t) => t.name);
    for (const n of ["fs.list", "fs.read", "fs.write", "system.info", "process.list", "shell.run", "stage.show", "stage.hide", "stage.clear", "stage.scene", "stage.update", "stage.presence", "stage.mood"]) {
      expect(names).toContain(n);
    }
    expect(TOOL_DEFS.find((t) => t.name === "shell.run")?.baseTier).toBe("T2");
    expect(TOOL_DEFS.find((t) => t.name === "stage.show")?.target).toBe("gateway");
  });
});
