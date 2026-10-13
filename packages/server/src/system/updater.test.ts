import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Updater, isNewerVersion, type UpdaterDeps } from "./updater";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

type Over = Partial<Omit<UpdaterDeps, "latest" | "current">> & { latest?: string | null; current?: string };

function make(over: Over = {}) {
  const notes: string[] = [];
  const applied: string[] = [];
  let busy = false;
  const deps: UpdaterDeps = {
    current: () => over.current ?? "0.1.44",
    latest: over.latest === undefined ? async () => "0.1.45" : typeof over.latest === "string" ? async () => over.latest as string : async () => null,
    auto: over.auto ?? (() => true),
    busy: over.busy ?? (() => busy),
    canApply: over.canApply ?? (() => true),
    apply: over.apply ?? (async (v) => (applied.push(v), true)),
    notify: (t) => void notes.push(t),
  };
  const u = new Updater(deps, { firstMs: 20_000, everyMs: 6 * 3600_000, retryMs: 5 * 60_000 });
  return { u, notes, applied, setBusy: (b: boolean) => (busy = b) };
}

describe("comparing versions", () => {
  it("knows which is newer", () => {
    expect(isNewerVersion("0.1.45", "0.1.44")).toBe(true);
    expect(isNewerVersion("0.2.0", "0.1.99")).toBe(true);
    expect(isNewerVersion("1.0.0", "0.9.9")).toBe(true);
    expect(isNewerVersion("0.1.44", "0.1.44")).toBe(false);
    expect(isNewerVersion("0.1.43", "0.1.44")).toBe(false);
    expect(isNewerVersion("0.1.10", "0.1.9")).toBe(true); // numbers, not letters
  });
  it("never treats a build from the source code as out of date", () => {
    expect(isNewerVersion("0.1.45", "development")).toBe(false);
  });
});

describe("looking for a newer Friend", () => {
  it("checks a little after it starts, not at once, and then every few hours", async () => {
    const f = make();
    const spy = vi.spyOn(f.u, "check");
    f.u.start();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spy).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(11_000);
    expect(spy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(6 * 3600_000);
    expect(spy).toHaveBeenCalledTimes(2);
    f.u.stop();
  });

  it("stops looking when stopped", async () => {
    const f = make();
    const spy = vi.spyOn(f.u, "check");
    f.u.start();
    f.u.stop();
    await vi.advanceTimersByTimeAsync(24 * 3600_000);
    expect(spy).not.toHaveBeenCalled();
  });

  it("says what it found", async () => {
    const { u } = make({ auto: () => false });
    expect(u.state()).toMatchObject({ current: "0.1.44", latest: null, available: false, checkedAt: null });
    const s = await u.check();
    expect(s).toMatchObject({ current: "0.1.44", latest: "0.1.45", available: true, error: null });
    expect(s.checkedAt).not.toBeNull();
  });

  it("finds nothing to do when it is up to date", async () => {
    const { u, notes, applied } = make({ current: "0.1.45" });
    expect((await u.check()).available).toBe(false);
    expect(notes).toEqual([]);
    expect(applied).toEqual([]);
  });

  it("copes with npm not answering, and says so", async () => {
    const { u, applied } = make({ latest: null });
    const s = await u.check();
    expect(s.error).toMatch(/could not ask npm/i);
    expect(s.available).toBe(false);
    expect(applied).toEqual([]);
  });

  it("asks npm once at a time", async () => {
    const latest = vi.fn(async () => "0.1.45");
    const n = new Updater({ current: () => "0.1.44", latest, auto: () => false, busy: () => false, canApply: () => true, apply: async () => true, notify: () => {} });
    await Promise.all([n.check(), n.check(), n.check()]);
    expect(latest).toHaveBeenCalledTimes(1);
  });
});

describe("updating by itself", () => {
  it("updates when it is switched on, Friend can restart itself, and nothing is going on", async () => {
    const { u, applied, notes } = make();
    await u.check();
    expect(applied).toEqual(["0.1.45"]);
    expect(notes.join(" ")).toMatch(/updating friend to 0\.1\.45/i);
    expect(u.state().applying).toBe(true);
  });

  it("does not update when the owner switched it off, and tells them once", async () => {
    const { u, applied, notes } = make({ auto: () => false });
    await u.check();
    await u.check();
    expect(applied).toEqual([]);
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatch(/0\.1\.45 is available/i);
    expect(notes[0]).toMatch(/settings/i);
  });

  it("tells them again when an even newer one comes out", async () => {
    let latest = "0.1.45";
    const notes: string[] = [];
    const u = new Updater({ current: () => "0.1.44", latest: async () => latest, auto: () => false, busy: () => false, canApply: () => true, apply: async () => true, notify: (t) => void notes.push(t) });
    await u.check();
    latest = "0.1.46";
    await u.check();
    expect(notes).toHaveLength(2);
    expect(notes[1]).toMatch(/0\.1\.46/);
  });

  it("only says what to run when Friend is in a terminal and cannot restart itself", async () => {
    const { u, applied, notes } = make({ canApply: () => false });
    await u.check();
    expect(applied).toEqual([]);
    expect(notes[0]).toMatch(/friend upgrade/);
    expect(u.state().canApply).toBe(false);
  });

  it("waits while Friend is busy, and updates a few minutes after it is free", async () => {
    const f = make();
    f.setBusy(true);
    await f.u.check();
    expect(f.applied).toEqual([]);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    expect(f.applied).toEqual([]); // still busy
    f.setBusy(false);
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 10);
    expect(f.applied).toEqual(["0.1.45"]);
  });

  it("does not start the update twice", async () => {
    const { u, applied } = make();
    await u.check();
    await u.check();
    await u.check();
    expect(applied).toEqual(["0.1.45"]);
  });

  it("says so and may try again when the update could not be started", async () => {
    let ok = false;
    const applied: string[] = [];
    const u = new Updater({ current: () => "0.1.44", latest: async () => "0.1.45", auto: () => true, busy: () => false, canApply: () => true, apply: async (v) => (applied.push(v), ok), notify: () => {} });
    await u.check();
    expect(u.state()).toMatchObject({ applying: false, error: expect.stringMatching(/could not start/i) });
    ok = true;
    await u.check();
    expect(applied).toEqual(["0.1.45", "0.1.45"]);
    expect(u.state().applying).toBe(true);
  });

  it("does not update on its own when the check said nothing newer", async () => {
    const { u, applied } = make({ current: "0.1.50" });
    await u.check();
    expect(applied).toEqual([]);
  });
});

describe("updating because the owner asked", () => {
  it("updates now, even with automatic updates off", async () => {
    const { u, applied } = make({ auto: () => false });
    await u.check();
    const r = await u.applyNow();
    expect(r).toMatchObject({ ok: true });
    expect(applied).toEqual(["0.1.45"]);
  });

  it("looks first when it has not looked yet", async () => {
    const { u, applied } = make({ auto: () => false });
    expect((await u.applyNow()).ok).toBe(true);
    expect(applied).toEqual(["0.1.45"]);
  });

  it("says when there is nothing newer", async () => {
    const { u, applied } = make({ current: "0.1.45" });
    const r = await u.applyNow();
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/up to date/i) });
    expect(applied).toEqual([]);
  });

  it("will not restart Friend in the middle of an answer", async () => {
    const f = make({ auto: () => false });
    f.setBusy(true);
    const r = await f.u.applyNow();
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/busy/i) });
    expect(f.applied).toEqual([]);
  });

  it("explains what to do when Friend is in a terminal", async () => {
    const { u } = make({ canApply: () => false, auto: () => false });
    const r = await u.applyNow();
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/friend upgrade/) });
  });

  it("says when it could not ask npm", async () => {
    const { u } = make({ latest: null });
    expect(await u.applyNow()).toMatchObject({ ok: false, message: expect.stringMatching(/could not ask npm/i) });
  });
});
