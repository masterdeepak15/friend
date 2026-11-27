import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Audit } from "../audit";
import { openDb } from "../db";
import { MailAutomationStore } from "./astore";
import { MailAutomation } from "./automation";

const at = (h: number, m: number, day = 10) => new Date(2026, 10, day, h, m, 0).getTime();

function rig(start = at(7, 0)) {
  const db = openDb(mkdtempSync(join(tmpdir(), "friend-automation-")));
  let now = start;
  const store = new MailAutomationStore(db, () => now);
  const ran: string[] = [];
  const state = { busy: false, up: true, detail: "HTTP 200" };
  const auto = new MailAutomation({
    store,
    audit: new Audit(db),
    now: () => now,
    enabled: () => true,
    run: async (instruction) => {
      if (state.busy) return false;
      ran.push(instruction);
      return true;
    },
    check: async () => ({ ok: state.up, detail: state.detail }),
  });
  return { store, auto, ran, state, set: (t: number) => (now = t) };
}

describe("schedules", () => {
  it("wake the assistant once at their time, with the owner's instruction", async () => {
    const r = rig();
    r.store.addSchedule({ name: "morning", kind: "daily", at: "08:00", instruction: "Email me the status of my servers using the template daily-status." });
    await r.auto.tick();
    expect(r.ran).toEqual([]);
    r.set(at(8, 1));
    await r.auto.tick();
    await r.auto.tick();
    expect(r.ran).toEqual(["Email me the status of my servers using the template daily-status."]);
    r.set(at(8, 1, 11));
    await r.auto.tick();
    expect(r.ran).toHaveLength(2);
  });

  it("wait for the next tick when the assistant is busy, and do not lose the run", async () => {
    const r = rig();
    r.store.addSchedule({ name: "morning", kind: "daily", at: "08:00", instruction: "report" });
    r.set(at(8, 1));
    r.state.busy = true;
    await r.auto.tick();
    expect(r.ran).toEqual([]);
    r.state.busy = false;
    await r.auto.tick();
    expect(r.ran).toEqual(["report"]);
  });
});

describe("watches", () => {
  const watch = (r: ReturnType<typeof rig>) => r.store.addWatch({ name: "shop", kind: "http", target: "https://shop.example.com", intervalSec: 60, instruction: "Email me an alert with the template server-down." });

  it("cost nothing while all is well: the assistant is not woken", async () => {
    const r = rig();
    watch(r);
    for (let i = 0; i < 5; i++) {
      r.set(at(7, 0) + i * 61_000);
      await r.auto.tick();
    }
    expect(r.ran).toEqual([]);
    expect(r.store.listWatches()[0]).toMatchObject({ state: "up" });
  });

  it("wake it once when the target goes down for two checks, and once when it is back", async () => {
    const r = rig();
    watch(r);
    r.set(at(7, 0) + 61_000);
    await r.auto.tick(); // up
    r.state.up = false;
    r.state.detail = "HTTP 502";
    r.set(at(7, 0) + 130_000);
    await r.auto.tick(); // first failure: not yet
    expect(r.ran).toEqual([]);
    r.set(at(7, 0) + 200_000);
    await r.auto.tick(); // second: down
    expect(r.ran).toHaveLength(1);
    expect(r.ran[0]).toContain("DOWN");
    expect(r.ran[0]).toContain("HTTP 502");
    expect(r.ran[0]).toContain("shop");
    expect(r.ran[0]).toContain("Email me an alert");
    r.set(at(7, 0) + 270_000);
    await r.auto.tick(); // still down: quiet
    expect(r.ran).toHaveLength(1);
    r.state.up = true;
    r.state.detail = "HTTP 200";
    r.set(at(7, 0) + 340_000);
    await r.auto.tick();
    expect(r.ran).toHaveLength(2);
    expect(r.ran[1]).toContain("UP");
  });

  it("do not check before their interval has passed", async () => {
    const r = rig();
    watch(r);
    r.set(at(7, 0) + 61_000); // the store and the automation agree on the time
    let checks = 0;
    const a = new MailAutomation({ store: r.store, audit: new Audit(openDb(mkdtempSync(join(tmpdir(), "friend-automation2-")))), now: () => at(7, 0) + 61_000, enabled: () => true, run: async () => true, check: async () => (checks++, { ok: true, detail: "" }) });
    await a.tick();
    await a.tick();
    expect(checks).toBe(1);
  });

  it("keep a change that came while the assistant was busy and tell it as soon as it can listen", async () => {
    const r = rig();
    watch(r);
    r.set(at(7, 0) + 61_000);
    await r.auto.tick();
    r.state.up = false;
    r.state.busy = true;
    r.set(at(7, 0) + 130_000);
    await r.auto.tick();
    r.set(at(7, 0) + 200_000);
    await r.auto.tick(); // down, but the assistant is busy
    expect(r.ran).toEqual([]);
    r.state.busy = false;
    await r.auto.tick();
    expect(r.ran).toHaveLength(1);
    expect(r.ran[0]).toContain("DOWN");
  });

  it("a check that itself breaks counts as a failure, not as a crash of the clock", async () => {
    const r = rig();
    const a = new MailAutomation({ store: r.store, audit: new Audit(openDb(mkdtempSync(join(tmpdir(), "friend-automation3-")))), now: () => at(7, 0) + 61_000, enabled: () => true, run: async () => true, check: async () => { throw new Error("boom"); } });
    watch(r);
    await expect(a.tick()).resolves.toBeUndefined();
    expect(r.store.listWatches()[0]).toMatchObject({ fails: 1, detail: expect.stringContaining("boom") });
  });
});
