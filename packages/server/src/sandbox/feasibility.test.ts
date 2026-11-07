import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";

const file = new URL("./feasibility.worker.mjs", import.meta.url);

function inWorker(engine: string): Promise<{ ok: boolean; out?: string[]; error?: string }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(file, { workerData: { engine } });
    w.once("message", (m) => {
      resolve(m);
      void w.terminate();
    });
    w.once("error", reject);
  });
}

describe("the three engines run inside a worker on this system", () => {
  it("quickjs runs in a worker", async () => {
    const r = await inWorker("quickjs");
    expect(r.error).toBeUndefined();
    expect(r.out).toEqual(["2"]);
  }, 30_000);
  it("pyodide runs in a worker", async () => {
    const r = await inWorker("pyodide");
    expect(r.error).toBeUndefined();
    expect(r.out?.join("")).toContain("2");
  }, 60_000);
  it("just-bash runs in a worker", async () => {
    const r = await inWorker("just-bash");
    expect(r.error).toBeUndefined();
    expect(r.out).toEqual(["hi"]);
  }, 30_000);
});
