import { describe, expect, it } from "vitest";
import { runInSandbox } from "./index";

const py = (code: string, over: { files?: Record<string, string>; timeoutMs?: number } = {}) =>
  runInSandbox({ language: "python", code, files: over.files ?? {}, timeoutMs: over.timeoutMs ?? 20_000 });

describe("Python in the built-in sandbox", () => {
  it("prints what the program prints", async () => {
    expect(await py("print(sum(range(5)))")).toMatchObject({ code: 0, stdout: "10\n", timedOut: false });
  }, 40_000);

  it("gives a non-zero code and the error for an exception", async () => {
    const r = await py("1/0");
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("ZeroDivisionError");
  }, 40_000);

  it("keeps the exit code of sys.exit", async () => {
    expect((await py("import sys\nsys.exit(3)")).code).toBe(3);
  }, 40_000);

  it("reads the files it was given", async () => {
    const r = await py('import json\nprint(json.load(open("args.json"))["value"])', { files: { "args.json": '{"value":5}' } });
    expect(r).toMatchObject({ code: 0, stdout: "5\n" });
  }, 40_000);

  it("says which module is missing, and does not have numpy", async () => {
    const r = await py("import numpy");
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("numpy");
  }, 40_000);

  it("cannot open a network connection", async () => {
    const r = await py("import socket\ns=socket.create_connection(('1.1.1.1',80),timeout=2)\nprint('CONNECTED')");
    expect(r.code).not.toBe(0);
    expect(r.stdout).not.toContain("CONNECTED");
  }, 40_000);

  it("is stopped at the time limit", async () => {
    const t = Date.now();
    const r = await py("while True: pass", { timeoutMs: 1500 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - t).toBeLessThan(15_000);
  }, 40_000);

  it("does not share anything between two runs", async () => {
    await py('open("left.txt","w").write("x")\nsecret_value = 42');
    const r = await py('import os\nprint(os.path.exists("left.txt"), "secret_value" in dir())');
    expect(r.stdout).toBe("False False\n");
  }, 80_000);
});
