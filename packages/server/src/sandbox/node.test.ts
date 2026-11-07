import { describe, expect, it } from "vitest";
import { runInSandbox } from "./index";

const js = (code: string, over: { files?: Record<string, string>; timeoutMs?: number } = {}) =>
  runInSandbox({ language: "node", code, files: over.files ?? {}, timeoutMs: over.timeoutMs ?? 5000 });

describe("JavaScript in the built-in sandbox", () => {
  it("prints what the program logs", async () => {
    const r = await js("console.log(2+3)");
    expect(r).toMatchObject({ code: 0, stdout: "5\n", timedOut: false });
  });

  it("gives a non-zero code and the error text for a thrown error", async () => {
    const r = await js('throw new Error("boom")');
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("boom");
  });

  it("reads files it was given, and has no way to reach anything else", async () => {
    const r = await js('console.log(readFile("data.txt")); console.log(typeof process, typeof require, typeof fetch, typeof fs, typeof Buffer)', { files: { "data.txt": "hello" } });
    expect(r.stdout).toBe("hello\nundefined undefined undefined undefined undefined\n");
    const missing = await js('readFile("../config.json")');
    expect(missing.code).not.toBe(0);
  });

  it("stops a program that never ends, and says so", async () => {
    const t = Date.now();
    const r = await js("while(true){}", { timeoutMs: 500 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t).toBeLessThan(2500);
  });

  it("stops a program that prints without end, with the output cut", async () => {
    const r = await js('while(true){ console.log("x".repeat(1000)) }', { timeoutMs: 5000 });
    expect(r.stdout.length).toBeLessThanOrEqual(40_000);
    expect(r.code).not.toBe(0);
  });

  it("survives a memory bomb, and the next program still runs", async () => {
    const bomb = await js("const a=[]; while(true){ a.push('x'.repeat(1e6)) }", { timeoutMs: 10_000 });
    expect(bomb.code).not.toBe(0);
    expect(bomb.outOfMemory || bomb.timedOut).toBe(true); // on a busy PC the time limit can come first
    expect(await js("console.log(1)")).toMatchObject({ code: 0, stdout: "1\n" });
  }, 30_000);
});
