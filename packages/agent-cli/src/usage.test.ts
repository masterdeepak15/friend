import { describe, expect, it, vi } from "vitest";
import type { UsageSummary } from "@friend/server";
import type { IO } from "./cli";
import { usageCommand } from "./commands/usage";

const day = (d: string, input = 0, output = 0, turns = 0) => ({ day: d, input, output, turns });
const summary = (over: Partial<UsageSummary> = {}): UsageSummary => ({
  range: 3,
  days: [day("2026-10-12"), day("2026-10-13", 1200, 300, 4), day("2026-10-14", 2_500_000, 40_000, 30)],
  total: { input: 2_501_200, output: 40_300, turns: 34 },
  byModel: [{ provider: "claude-code", model: "sonnet", input: 2_501_200, output: 40_300, turns: 34 }],
  bySource: [{ source: "voice", input: 2_501_200, output: 40_300, turns: 34 }],
  ...over,
});
function setup(s = summary()) {
  const out: string[] = [];
  const err: string[] = [];
  const io: IO = { dataDir: "/d", out: (l) => out.push(l), err: (l) => err.push(l), ask: async () => "" };
  const log = { summary: vi.fn((_days: number) => s), clear: vi.fn(() => 7) };
  return { io, out, err, log, text: () => out.join("\n") };
}

describe("friend usage", () => {
  it("shows each day, the total, and the split by model and by where it came from", async () => {
    const t = setup();
    expect(await usageCommand([], t.io, t.log)).toBe(0);
    expect(t.log.summary).toHaveBeenCalledWith(7);
    const text = t.text();
    expect(text).toMatch(/2026-10-13\s+1,200\s+300\s+4/);
    expect(text).toMatch(/2026-10-14\s+2,500,000\s+40,000\s+30/);
    expect(text).toMatch(/Total\s+2,501,200\s+40,300\s+34/);
    expect(text).toMatch(/claude-code \/ sonnet/);
    expect(text).toMatch(/voice/);
  });

  it("looks back as many days as asked", async () => {
    const t = setup();
    await usageCommand(["--days", "30"], t.io, t.log);
    expect(t.log.summary).toHaveBeenCalledWith(30);
  });

  it("refuses a number of days that is not a number", async () => {
    const t = setup();
    expect(await usageCommand(["--days", "lots"], t.io, t.log)).toBe(1);
    expect(t.err.join("\n")).toMatch(/Usage: friend usage/);
    expect(t.log.summary).not.toHaveBeenCalled();
  });

  it("says plainly when nothing has been used", async () => {
    const t = setup(summary({ days: [day("2026-10-14")], total: { input: 0, output: 0, turns: 0 }, byModel: [], bySource: [] }));
    expect(await usageCommand([], t.io, t.log)).toBe(0);
    expect(t.text()).toMatch(/nothing used/i);
  });

  it("clears the counts when told to", async () => {
    const t = setup();
    expect(await usageCommand(["clear"], t.io, t.log)).toBe(0);
    expect(t.log.clear).toHaveBeenCalledTimes(1);
    expect(t.text()).toMatch(/removed 7/i);
  });

  it("says it keeps counts only", async () => {
    const t = setup();
    await usageCommand([], t.io, t.log);
    expect(t.text()).toMatch(/counts only/i);
  });
});
