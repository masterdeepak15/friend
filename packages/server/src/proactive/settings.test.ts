import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, sanitizeProactive } from "../config";
import { applySettings, refuseForAgent, settingsView } from "../settings";

const fresh = () => loadConfig(mkdtempSync(join(tmpdir(), "friend-proactive-")));

describe("the heartbeat settings", () => {
  it("start off, with kind limits: quiet at night, six a day, half an hour apart, silent aloud", () => {
    expect(fresh().proactive).toEqual({ level: "off", quietFrom: "22:00", quietTo: "07:00", morningAt: "08:00", eveningAt: "20:30", dailyCap: 6, minGapMin: 30, silenceHours: 8, speak: false, phone: true });
  });

  it("keep every value inside its range, and ignore what is not a time", () => {
    expect(sanitizeProactive({ dailyCap: 99, minGapMin: 1, silenceHours: 500, quietFrom: "25:00", morningAt: "9:5" })).toMatchObject({ dailyCap: 20, minGapMin: 5, silenceHours: 72, quietFrom: "22:00", morningAt: "08:00" });
  });

  it("are saved from the settings screen, and a bad value is refused without changing anything", () => {
    const c = fresh();
    applySettings(c, { proactive: { level: "medium", quietFrom: "23:30", speak: true } });
    expect(c.proactive).toMatchObject({ level: "medium", quietFrom: "23:30", speak: true });
    for (const bad of [{ level: "loud" }, { quietTo: "7am" }, { dailyCap: 0 }, { minGapMin: 1 }, { nope: 1 }]) expect(() => applySettings(c, { proactive: bad })).toThrow();
    expect(c.proactive.level).toBe("medium");
    expect(settingsView(c).proactive.quietFrom).toBe("23:30");
  });

  it("cannot be changed by the assistant itself", () => {
    expect(() => refuseForAgent({ proactive: { level: "high" } } as never)).toThrow(/only be changed by the owner/);
  });
});
