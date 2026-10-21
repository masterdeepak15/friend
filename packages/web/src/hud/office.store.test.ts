import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../store";

const worker = (id: string, over: Record<string, unknown> = {}) => ({ id, name: id.toUpperCase(), roleId: "scribe", title: "Scribe", capabilities: "", managerId: null, projectId: "site", status: "idle", ticketId: null, detail: "", tokens: 0, budget: null, startedAt: null, ...over });
const quota = { fiveHour: { utilization: 0.42, resetsAt: 1792516200 }, sevenDay: null };
const state = (workers: unknown[], over: Record<string, unknown> = {}) => ({ type: "office.state", enabled: true, workers, tickets: [{ id: 1, projectId: "site", title: "Fix it", status: "doing", workerId: "w1" }], quota, ...over });
const feed = (workerId: string, text: string, at = 1) => ({ type: "office.feed", workerId, at, kind: "text", text });

describe("the office in the screen state", () => {
  it("starts empty and off", () => {
    expect(initialState.office).toEqual({ enabled: false, workers: [], tickets: [], quota: { fiveHour: null, sevenDay: null }, feed: {} });
  });

  it("takes the workers, tickets, quota and switch from an office.state", () => {
    const s = reduce(initialState, state([worker("w1")]));
    expect(s.office.enabled).toBe(true);
    expect(s.office.workers.map((w) => w.id)).toEqual(["w1"]);
    expect(s.office.tickets).toHaveLength(1);
    expect(s.office.quota.fiveHour?.utilization).toBe(0.42);
  });

  it("adds feed lines per worker, oldest first", () => {
    let s = reduce(initialState, state([worker("w1"), worker("w2")]));
    s = reduce(s, feed("w1", "one", 1));
    s = reduce(s, feed("w1", "two", 2));
    s = reduce(s, feed("w2", "other", 3));
    expect(s.office.feed.w1!.map((l) => l.text)).toEqual(["one", "two"]);
    expect(s.office.feed.w2!.map((l) => l.text)).toEqual(["other"]);
  });

  it("keeps only the newest 60 lines of a worker", () => {
    let s = reduce(initialState, state([worker("w1")]));
    for (let i = 0; i < 75; i++) s = reduce(s, feed("w1", `line ${i}`, i));
    expect(s.office.feed.w1).toHaveLength(60);
    expect(s.office.feed.w1![0]!.text).toBe("line 15");
    expect(s.office.feed.w1!.at(-1)!.text).toBe("line 74");
  });

  it("forgets the feed of a worker that is gone", () => {
    let s = reduce(initialState, state([worker("w1"), worker("w2")]));
    s = reduce(s, feed("w1", "a"));
    s = reduce(s, feed("w2", "b"));
    s = reduce(s, state([worker("w2")]));
    expect(Object.keys(s.office.feed)).toEqual(["w2"]);
  });

  it("ignores a feed line for a worker it does not know, and malformed input", () => {
    const s = reduce(initialState, state([worker("w1")]));
    expect(reduce(s, feed("ghost", "x")).office.feed).toEqual({});
    expect(reduce(s, { type: "office.state", enabled: "yes" })).toBe(s);
    expect(reduce(s, { type: "office.feed", workerId: "w1", at: 1, kind: "nope", text: "x" })).toBe(s);
  });
});
