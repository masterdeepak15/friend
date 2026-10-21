import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "./db";
import { UsageLog, localDay } from "./usage";

const at = (iso: string) => new Date(iso).getTime();
function make(now = at("2026-10-14T10:00:00")) {
  const clock = { now };
  const db = openDb(mkdtempSync(join(tmpdir(), "friend-usage-")));
  const log = new UsageLog(db, () => clock.now);
  return { log, clock, db };
}
const turn = (over: Partial<Parameters<UsageLog["record"]>[0]> = {}) => ({ provider: "claude-code", model: "sonnet", source: "chat", input: 100, output: 20, ...over });

describe("the local day", () => {
  it("is the date on the computer's own clock, not UTC", () => {
    expect(localDay(at("2026-10-14T00:30:00"))).toBe("2026-10-14");
    expect(localDay(at("2026-10-14T23:59:00"))).toBe("2026-10-14");
    expect(localDay(at("2026-01-05T08:00:00"))).toBe("2026-01-05");
  });
});

describe("keeping count of tokens", () => {
  it("adds up what was used each day, and how many turns", () => {
    const { log, clock } = make();
    log.record(turn({ input: 100, output: 20 }));
    log.record(turn({ input: 50, output: 10 }));
    clock.now = at("2026-10-15T09:00:00");
    log.record(turn({ input: 7, output: 3 }));
    const days = log.days(3);
    expect(days.find((d) => d.day === "2026-10-14")).toEqual({ day: "2026-10-14", input: 150, output: 30, turns: 2 });
    expect(days.find((d) => d.day === "2026-10-15")).toEqual({ day: "2026-10-15", input: 7, output: 3, turns: 1 });
  });

  it("lists every day in the range, oldest first, with zeros for quiet days", () => {
    const { log } = make();
    log.record(turn());
    const days = log.days(5);
    expect(days.map((d) => d.day)).toEqual(["2026-10-10", "2026-10-11", "2026-10-12", "2026-10-13", "2026-10-14"]);
    expect(days[0]).toEqual({ day: "2026-10-10", input: 0, output: 0, turns: 0 });
  });

  it("leaves out days older than the range", () => {
    const { log, clock } = make(at("2026-10-01T10:00:00"));
    log.record(turn({ input: 999 }));
    clock.now = at("2026-10-14T10:00:00");
    expect(log.days(7).reduce((n, d) => n + d.input, 0)).toBe(0);
    expect(log.days(30).reduce((n, d) => n + d.input, 0)).toBe(999);
  });

  it("does not write down a turn that used nothing", () => {
    const { log } = make();
    log.record(turn({ input: 0, output: 0 }));
    expect(log.totals(7).turns).toBe(0);
  });

  it("never stores a negative or fractional count", () => {
    const { log } = make();
    log.record(turn({ input: -5, output: 3.7 }));
    expect(log.totals(7)).toEqual({ input: 0, output: 3, turns: 1 });
  });

  it("totals the range", () => {
    const { log, clock } = make(at("2026-10-13T09:00:00"));
    log.record(turn({ input: 20, output: 2 }));
    clock.now = at("2026-10-14T10:00:00");
    log.record(turn({ input: 10, output: 1 }));
    expect(log.totals(7)).toEqual({ input: 30, output: 3, turns: 2 });
    expect(log.totals(1)).toEqual({ input: 10, output: 1, turns: 1 });
  });

  it("splits by model and by where the request came from, biggest first", () => {
    const { log } = make();
    log.record(turn({ model: "sonnet", source: "voice", input: 100, output: 10 }));
    log.record(turn({ model: "haiku", source: "chat", input: 10, output: 1 }));
    log.record(turn({ model: "sonnet", source: "voice", input: 50, output: 5 }));
    expect(log.byModel(7)).toEqual([
      { provider: "claude-code", model: "sonnet", input: 150, output: 15, turns: 2 },
      { provider: "claude-code", model: "haiku", input: 10, output: 1, turns: 1 },
    ]);
    expect(log.bySource(7)).toEqual([
      { source: "voice", input: 150, output: 15, turns: 2 },
      { source: "chat", input: 10, output: 1, turns: 1 },
    ]);
  });

  it("keeps only plain words for the model and where it came from", () => {
    const { log, db } = make();
    log.record(turn({ model: "x".repeat(500), source: "a<b>\n" }));
    const row = db.prepare("select model, source from usage").get() as { model: string; source: string };
    expect(row.model.length).toBeLessThanOrEqual(80);
    expect(row.source).toBe("other");
  });
});

describe("old numbers", () => {
  it("are removed after the days to keep, and only those", () => {
    const { log, clock } = make(at("2026-01-01T10:00:00"));
    log.record(turn({ input: 1 }));
    clock.now = at("2026-10-14T10:00:00");
    log.record(turn({ input: 2 }));
    expect(log.prune(100)).toBe(1);
    expect(log.totals(400)).toEqual({ input: 2, output: 20, turns: 1 });
  });

  it("can all be cleared", () => {
    const { log } = make();
    log.record(turn());
    log.record(turn());
    expect(log.clear()).toBe(2);
    expect(log.totals(30).turns).toBe(0);
  });
});

describe("a summary for the screen", () => {
  it("has the days, the totals and both splits in one go", () => {
    const { log } = make();
    log.record(turn({ source: "voice" }));
    const s = log.summary(7);
    expect(s.days).toHaveLength(7);
    expect(s.total).toEqual({ input: 100, output: 20, turns: 1 });
    expect(s.byModel).toHaveLength(1);
    expect(s.bySource).toEqual([{ source: "voice", input: 100, output: 20, turns: 1 }]);
    expect(s.range).toBe(7);
  });

  it("keeps the range between 1 and 366 days", () => {
    const { log } = make();
    expect(log.summary(0).range).toBe(1);
    expect(log.summary(99999).range).toBe(366);
    expect(log.summary(Number.NaN).range).toBe(30);
  });
});

describe("the Office as a source of tokens", () => {
  it("keeps its own name instead of being filed under other", () => {
    const { log } = make();
    log.record(turn({ source: "office", input: 70, output: 7 }));
    log.record(turn({ source: "something-else", input: 1, output: 1 }));
    const by = Object.fromEntries(log.bySource(7).map((r) => [r.source, r.input]));
    expect(by.office).toBe(70);
    expect(by.other).toBe(1);
  });
});