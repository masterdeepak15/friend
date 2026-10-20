import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db";
import { MAX_EVENTS_PER_WORKER, MAX_EVENT_CHARS, OfficeStore } from "./store";

let dir: string;
let store: OfficeStore;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "friend-officestore-"));
  store = new OfficeStore(openDb(dir));
});

describe("workers", () => {
  it("are created idle with a short id, and found by id or by name in any case", () => {
    const w = store.createWorker({ name: "Ada", roleId: "builder", projectId: "site" });
    expect(w).toMatchObject({ name: "Ada", roleId: "builder", projectId: "site", status: "idle", sessionId: null, ticketId: null, tokens: 0 });
    expect(w.id).toMatch(/^[a-z0-9]{6,12}$/);
    expect(store.getWorker(w.id)?.name).toBe("Ada");
    expect(store.findWorker(w.id)?.id).toBe(w.id);
    expect(store.findWorker("aDa")?.id).toBe(w.id);
    expect(store.findWorker("nobody")).toBeUndefined();
    expect(store.listWorkers().map((x) => x.name)).toEqual(["Ada"]);
  });

  it("change status, session, ticket and what they are doing, and add up their tokens", () => {
    const w = store.createWorker({ name: "Ada", roleId: "builder", projectId: "site" });
    store.patchWorker(w.id, { status: "running", sessionId: "s-1", ticketId: 4, detail: "Write a.txt", startedAt: 99 });
    store.addTokens(w.id, 120);
    store.addTokens(w.id, 30);
    expect(store.getWorker(w.id)).toMatchObject({ status: "running", sessionId: "s-1", ticketId: 4, detail: "Write a.txt", startedAt: 99, tokens: 150 });
  });

  it("take their events with them when they are removed", () => {
    const w = store.createWorker({ name: "Ada", roleId: "builder", projectId: "site" });
    store.addEvent(w.id, { kind: "text", text: "hello" });
    store.removeWorker(w.id);
    expect(store.getWorker(w.id)).toBeUndefined();
    expect(store.events(w.id)).toEqual([]);
  });
});

describe("tickets", () => {
  it("start as todo, and change status and worker", () => {
    const t = store.createTicket({ projectId: "site", title: "Fix login", description: "Details" });
    expect(t).toMatchObject({ projectId: "site", title: "Fix login", description: "Details", status: "todo", workerId: null });
    store.patchTicket(t.id, { status: "doing", workerId: "w1" });
    expect(store.getTicket(t.id)).toMatchObject({ status: "doing", workerId: "w1" });
    expect(store.listTickets("site")).toHaveLength(1);
    expect(store.listTickets("other")).toHaveLength(0);
    expect(store.listTickets()).toHaveLength(1);
  });
});

describe("events", () => {
  it("are clipped, newest last, and only the newest are kept", () => {
    const w = store.createWorker({ name: "Ada", roleId: "builder", projectId: "site" });
    store.addEvent(w.id, { kind: "text", text: "x".repeat(MAX_EVENT_CHARS + 50) });
    expect(store.events(w.id)[0]!.text).toHaveLength(MAX_EVENT_CHARS);
    for (let i = 0; i < MAX_EVENTS_PER_WORKER + 20; i++) store.addEvent(w.id, { kind: "tool", text: `step ${i}` });
    const all = store.events(w.id, 10_000);
    expect(all).toHaveLength(MAX_EVENTS_PER_WORKER);
    expect(all.at(-1)!.text).toBe(`step ${MAX_EVENTS_PER_WORKER + 19}`);
    expect(store.events(w.id, 3).map((e) => e.text)).toEqual([`step ${MAX_EVENTS_PER_WORKER + 17}`, `step ${MAX_EVENTS_PER_WORKER + 18}`, `step ${MAX_EVENTS_PER_WORKER + 19}`]);
  });
});

describe("after a crash", () => {
  it("workers left running become stopped, their ticket goes back to todo, and finished work is left alone", () => {
    const a = store.createWorker({ name: "Ada", roleId: "builder", projectId: "site" });
    const done = store.createTicket({ projectId: "site", title: "Old", description: "" });
    const doing = store.createTicket({ projectId: "site", title: "Now", description: "" });
    store.patchTicket(done.id, { status: "done", workerId: a.id });
    store.patchTicket(doing.id, { status: "doing", workerId: a.id });
    store.patchWorker(a.id, { status: "running", ticketId: doing.id });
    store.resetRunning();
    expect(store.getWorker(a.id)!.status).toBe("stopped");
    expect(store.getTicket(doing.id)!.status).toBe("todo");
    expect(store.getTicket(done.id)!.status).toBe("done");
  });

  it("does not touch idle workers", () => {
    const a = store.createWorker({ name: "Ada", roleId: "builder", projectId: "site" });
    store.resetRunning();
    expect(store.getWorker(a.id)!.status).toBe("idle");
  });
});

describe("the database", () => {
  it("opens twice without trouble and keeps what was saved", () => {
    const w = store.createWorker({ name: "Ada", roleId: "builder", projectId: "site" });
    const again = new OfficeStore(openDb(dir));
    expect(again.getWorker(w.id)?.name).toBe("Ada");
  });
});
