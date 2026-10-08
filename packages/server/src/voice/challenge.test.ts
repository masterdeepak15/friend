import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Challenges } from "./challenge";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("Challenges", () => {
  it("holds one pending utterance and reports the one it replaced", () => {
    const c = new Challenges(() => {});
    const a = c.open("first", "1.1.1.1");
    expect(a.replaced).toBeNull();
    const b = c.open("second", "1.1.1.1");
    expect(b.replaced).toBe(a.challenge.id);
    expect(c.get(a.challenge.id)).toBeNull();
    expect(c.get(b.challenge.id)?.text).toBe("second");
  });

  it("hands over a challenge exactly once", () => {
    const c = new Challenges(() => {});
    const { challenge } = c.open("do it", "ip");
    expect(c.take(challenge.id)?.text).toBe("do it");
    expect(c.take(challenge.id)).toBeNull();
    expect(c.get(challenge.id)).toBeNull();
  });

  it("expires after the time limit and tells the owner screen", () => {
    const expired: string[] = [];
    const c = new Challenges((id) => expired.push(id), 60_000);
    const { challenge } = c.open("x", "ip");
    vi.advanceTimersByTime(59_000);
    expect(c.get(challenge.id)).not.toBeNull();
    vi.advanceTimersByTime(2_000);
    expect(expired).toEqual([challenge.id]);
    expect(c.get(challenge.id)).toBeNull();
  });

  it("discards the challenge after three wrong PINs", () => {
    const c = new Challenges(() => {}, 60_000, 3);
    const { challenge } = c.open("x", "ip");
    expect(c.wrongPin(challenge.id)).toBe(false);
    expect(c.wrongPin(challenge.id)).toBe(false);
    expect(c.wrongPin(challenge.id)).toBe(true);
    expect(c.get(challenge.id)).toBeNull();
  });

  it("clears everything on lock and does not expire a cleared challenge", () => {
    const expired: string[] = [];
    const c = new Challenges((id) => expired.push(id));
    const { challenge } = c.open("x", "ip");
    expect(c.clear()).toBe(challenge.id);
    expect(c.clear()).toBeNull();
    vi.advanceTimersByTime(120_000);
    expect(expired).toEqual([]);
  });

  it("ignores ids that are not the pending one", () => {
    const c = new Challenges(() => {});
    c.open("x", "ip");
    expect(c.get("nope")).toBeNull();
    expect(c.take("nope")).toBeNull();
    expect(c.wrongPin("nope")).toBe(false);
  });
});
