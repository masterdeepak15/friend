import { describe, expect, it } from "vitest";
import { systemInfo } from "./system";

describe("systemInfo", () => {
  it("reports the machine, with CPU load, memory, disk and uptime on lines a program can read", async () => {
    const r = await systemInfo(20);
    expect(r.ok).toBe(true);
    const out = r.ok ? r.output : "";
    expect(out).toMatch(/^platform: /m);
    expect(out).toMatch(/^host: /m);
    expect(out).toMatch(/^cpu: .+ x\d+$/m);
    expect(out).toMatch(/^cpu load: \d{1,3}%$/m);
    expect(out).toMatch(/^memory: [\d.]+ GB free of [\d.]+ GB$/m);
    expect(out).toMatch(/^disk: [\d.]+ GB free of [\d.]+ GB \(.+\)$/m);
    expect(out).toMatch(/^uptime: [\d.]+ hours$/m);
  });

  it("keeps the CPU load within 0 to 100", async () => {
    const out = (await systemInfo(20)) as { ok: true; output: string };
    const load = Number(/^cpu load: (\d+)%$/m.exec(out.output)![1]);
    expect(load).toBeGreaterThanOrEqual(0);
    expect(load).toBeLessThanOrEqual(100);
  });
});
