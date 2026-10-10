import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { openDb } from "../db";
import { ReportScheduler, localDay, localTime, localWeekday } from "./scheduler";
import { ReportSchedules, type NewSchedule, type Schedule } from "./schedules";

const db = () => openDb(mkdtempSync(join(tmpdir(), "friend-sched-")));
const base: NewSchedule = { name: "Morning", broker: "zerodha", kind: "morning", time: "09:30", days: [1, 2, 3, 4, 5], channel: "telegram", commentary: false, enabled: true };
/** Monday 12 October 2026 at the given India time (IST is UTC+5:30). */
const ist = (day: number, hh: number, mm: number) => new Date(Date.UTC(2026, 9, day, hh, mm) - 5.5 * 3600_000);

function setup(over: { skip?: string[]; run?: (s: Schedule) => Promise<void> } = {}) {
  const schedules = new ReportSchedules(db());
  const ran: number[] = [];
  const run = over.run ?? (async (s: Schedule) => void ran.push(s.id));
  const scheduler = new ReportScheduler({ schedules, zone: () => "Asia/Kolkata", skipDates: () => over.skip ?? [], run });
  return { schedules, scheduler, ran };
}

describe("when a schedule runs", () => {
  it("at its time, once a day, even if the tick comes a little late", async () => {
    const { schedules, scheduler, ran } = setup();
    const s = schedules.add(base);
    expect(await scheduler.tick(ist(12, 9, 29))).toBe(0);
    expect(await scheduler.tick(ist(12, 9, 30))).toBe(1);
    expect(await scheduler.tick(ist(12, 9, 31))).toBe(0);
    expect(await scheduler.tick(ist(12, 15, 0))).toBe(0);
    expect(ran).toEqual([s.id]);
  });

  it("again the next day", async () => {
    const { schedules, scheduler, ran } = setup();
    schedules.add(base);
    await scheduler.tick(ist(12, 9, 30));
    await scheduler.tick(ist(13, 9, 30));
    expect(ran).toHaveLength(2);
  });

  it("not on a day it is not set for, a skipped date or when switched off", async () => {
    const { schedules, scheduler, ran } = setup({ skip: ["2026-10-12"] });
    schedules.add(base);
    schedules.add({ ...base, name: "Off", enabled: false });
    expect(await scheduler.tick(ist(10, 9, 30))).toBe(0); // Saturday
    expect(await scheduler.tick(ist(12, 9, 30))).toBe(0); // skipped date
    expect(await scheduler.tick(ist(13, 9, 30))).toBe(1); // Tuesday: only the enabled one
    expect(ran).toHaveLength(1);
  });

  it("catches up a report missed because Friend was off, once, and not the next morning", async () => {
    const { schedules, scheduler, ran } = setup();
    schedules.add(base);
    expect(await scheduler.tick(ist(12, 23, 59))).toBe(1); // started late in the evening
    expect(await scheduler.tick(ist(13, 0, 5))).toBe(0); // nothing is due yet the next day
    expect(ran).toHaveLength(1);
  });

  it("never twice after a restart", async () => {
    const schedules = new ReportSchedules(db());
    schedules.add(base);
    const count = vi.fn(async () => {});
    const make = () => new ReportScheduler({ schedules, zone: () => "Asia/Kolkata", skipDates: () => [], run: count });
    await make().tick(ist(12, 9, 30));
    await make().tick(ist(12, 9, 31)); // a new scheduler over the same saved state
    expect(count).toHaveBeenCalledTimes(1);
    expect(schedules.list()[0]!.lastRunDay).toBe("2026-10-12");
  });

  it("uses the owner's time zone, not the computer's", () => {
    const at = new Date(Date.UTC(2026, 9, 12, 4, 0));
    expect(localTime(at, "Asia/Kolkata")).toBe("09:30");
    expect(localTime(at, "UTC")).toBe("04:00");
    expect(localDay(new Date(Date.UTC(2026, 9, 12, 20, 0)), "Asia/Kolkata")).toBe("2026-10-13"); // already tomorrow in India
    expect(localWeekday(new Date(Date.UTC(2026, 9, 12, 4, 0)), "Asia/Kolkata")).toBe(1); // Monday
    expect(localWeekday(new Date(Date.UTC(2026, 9, 11, 4, 0)), "Asia/Kolkata")).toBe(7); // Sunday
  });
});

describe("when a report cannot be sent", () => {
  it("does not stop the others and is not marked as run", async () => {
    const calls: string[] = [];
    const { schedules, scheduler } = setup({
      run: async (s) => {
        calls.push(s.name);
        if (s.name === "Broken") throw new Error("channel down");
      },
    });
    schedules.add({ ...base, name: "Broken" });
    schedules.add({ ...base, name: "Fine" });
    expect(await scheduler.tick(ist(12, 9, 30))).toBe(1);
    expect(calls).toEqual(["Broken", "Fine"]);
    expect(schedules.list().find((s) => s.name === "Broken")!.lastRunDay).toBeNull();
    expect(schedules.list().find((s) => s.name === "Fine")!.lastRunDay).toBe("2026-10-12");
  });

  it("is tried again, up to three times in a day", async () => {
    const run = vi.fn(async () => {
      throw new Error("down");
    });
    const { schedules, scheduler } = setup({ run });
    schedules.add(base);
    for (let i = 0; i < 6; i++) await scheduler.tick(ist(12, 9, 30 + i));
    expect(run).toHaveBeenCalledTimes(3);
    await scheduler.tick(ist(13, 9, 30)); // a new day starts with a clean count
    expect(run).toHaveBeenCalledTimes(4);
  });
});

describe("the schedules store", () => {
  it("adds, lists and removes", () => {
    const { schedules } = setup();
    const a = schedules.add(base);
    expect(a).toMatchObject({ name: "Morning", broker: "zerodha", time: "09:30", days: [1, 2, 3, 4, 5], channel: "telegram", enabled: true, lastRunDay: null });
    expect(schedules.list()).toHaveLength(1);
    expect(schedules.remove(a.id)).toBe(true);
    expect(schedules.remove(a.id)).toBe(false);
    expect(schedules.list()).toEqual([]);
  });

  it("refuses a time, days, channel, kind or name that make no sense", () => {
    const { schedules } = setup();
    for (const bad of [{ time: "25:00" }, { time: "9:30" }, { time: "09:60" }, { days: [] }, { days: [0] }, { days: [8] }, { channel: "pigeon" }, { kind: "weekly" }, { name: "" }, { name: "x".repeat(61) }]) {
      expect(() => schedules.add({ ...base, ...(bad as Partial<NewSchedule>) })).toThrow();
    }
  });

  it("keeps no more than twenty schedules", () => {
    const { schedules } = setup();
    for (let i = 0; i < 20; i++) schedules.add({ ...base, name: `s${i}` });
    expect(() => schedules.add(base)).toThrow(/at most 20/);
  });
});
