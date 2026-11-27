import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Control, type Phase } from "./control";
import { StatusKeeper } from "./status";
import { AgentStore, type Sealer } from "./store";
import { Tasks } from "./tasks";

/** Time that only moves when told to, with timers that fire in order. */
function clock() {
  let now = 1_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  return {
    now: () => now,
    setTimer: (fn: () => void, ms: number) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => (t.live = false);
    },
    advance(ms: number) {
      const to = now + ms;
      for (;;) {
        const next = timers.filter((t) => t.live && t.at <= to).sort((a, b) => a.at - b.at)[0];
        if (!next) break;
        next.live = false;
        now = next.at;
        next.fn();
      }
      now = to;
    },
    pending: () => timers.filter((t) => t.live).length,
  };
}
const file = () => join(mkdtempSync(join(tmpdir(), "friend-agent-")), "agent.db");
const reverse: Sealer = { seal: async (p) => Buffer.from([...p].reverse().join("")).toString("base64"), unseal: async (s) => [...Buffer.from(s, "base64").toString()].reverse().join("") };

describe("the agent's own database", () => {
  it("keeps settings, tasks and events across a restart", () => {
    const path = file();
    const a = new AgentStore(path);
    a.set("server", "https://maya.example.com");
    a.addTask("update the report");
    a.addEvent({ tool: "pc.click", ok: true, window: "Notepad", detail: "label 4" });
    a.close();
    const b = new AgentStore(path);
    expect(b.get("server")).toBe("https://maya.example.com");
    expect(b.tasks().map((t) => [t.title, t.state])).toEqual([["update the report", "queued"]]);
    expect(b.events(5)[0]).toMatchObject({ tool: "pc.click", ok: true, window: "Notepad" });
    b.close();
  });

  it("keeps a secret only in its sealed form, and cannot read one sealed for somebody else", async () => {
    const path = file();
    const a = new AgentStore(path);
    await a.setSecret(reverse, "refresh", "super-secret-token-123");
    expect(await a.getSecret(reverse, "refresh")).toBe("super-secret-token-123");
    a.close();
    expect(readFileSync(path).toString("latin1")).not.toContain("super-secret-token-123");
    const b = new AgentStore(path);
    const stranger: Sealer = { seal: reverse.seal, unseal: async () => { throw new Error("not for this user"); } };
    expect(await b.getSecret(stranger, "refresh")).toBeNull();
    expect(await b.getSecret(reverse, "nothing")).toBeNull();
    b.close();
  });
});

describe("a control session", () => {
  function rig(opts: { countdownMs?: number; idleMs?: number } = {}) {
    const c = clock();
    const log: string[] = [];
    const control = new Control({ now: c.now, setTimer: c.setTimer, onChange: (p: Phase, why) => log.push(`${p}:${why}`), ...opts });
    return { c, control, log };
  }

  it("counts down first, then may act, and only one runs at a time", () => {
    const { c, control, log } = rig();
    expect(control.canAct()).toBe(false);
    expect(control.start(10)).toEqual({ ok: true });
    expect(control.phase()).toBe("countdown");
    expect(control.canAct()).toBe(false);
    expect(control.start(10)).toMatchObject({ ok: false, error: expect.stringMatching(/already/) });
    c.advance(3000);
    expect(control.phase()).toBe("active");
    expect(control.canAct()).toBe(true);
    expect(log).toEqual(["countdown:starting in 3 seconds", "active:running"]);
  });

  it("pauses the moment the person at the PC uses the mouse or keyboard, and needs a new start with its own countdown", () => {
    const { c, control } = rig();
    control.start(10);
    c.advance(3000);
    control.humanInput();
    expect(control.phase()).toBe("paused");
    expect(control.canAct()).toBe(false);
    c.advance(60_000);
    expect(control.canAct()).toBe(false);
    expect(control.start(10)).toEqual({ ok: true });
    expect(control.canAct()).toBe(false);
    c.advance(3000);
    expect(control.canAct()).toBe(true);
  });

  it("a person using the PC during the countdown stops it too, so nothing moves under their hand", () => {
    const { c, control } = rig();
    control.start(10);
    control.humanInput();
    c.advance(5000);
    expect(control.phase()).toBe("paused");
  });

  it("ends by the hotkey, by the time limit, by idleness, and not when it is used", () => {
    const a = rig();
    a.control.start(10);
    a.c.advance(3000);
    a.control.end("hotkey");
    expect(a.control.phase()).toBe("idle");
    expect(a.control.canAct()).toBe(false);
    expect(a.c.pending()).toBe(0); // no timer is left

    const b = rig();
    b.control.start(1);
    b.c.advance(3000);
    b.c.advance(60_000);
    expect(b.control.phase()).toBe("idle");
    expect(b.log.at(-1)).toBe("idle:time is up");

    const c = rig({ idleMs: 5 * 60_000 });
    c.control.start(60);
    c.c.advance(3000);
    for (let i = 0; i < 4; i++) {
      c.c.advance(4 * 60_000);
      c.control.touch();
    }
    expect(c.control.phase()).toBe("active");
    c.c.advance(5 * 60_000 + 1);
    expect(c.control.phase()).toBe("idle");
    expect(c.log.at(-1)).toBe("idle:idle for too long");
  });

  it("ending twice, or a human with no session, changes nothing", () => {
    const { control, log } = rig();
    control.humanInput();
    control.end("x");
    expect(log).toEqual([]);
  });
});

describe("tasks that survive a restart", () => {
  it("run one at a time in the order chosen, and finish with a state", () => {
    const store = new AgentStore(file());
    const tasks = new Tasks(store);
    const a = tasks.add("update the report");
    const b = tasks.add("install the printer");
    expect(tasks.start(a.id)).toMatchObject({ ok: true });
    expect(tasks.start(b.id)).toMatchObject({ ok: false, error: expect.stringMatching(/update the report.*running/) });
    expect(tasks.current()?.id).toBe(a.id);
    expect(tasks.finish(a.id, "done", "saved as report.docx")).toEqual({ ok: true });
    expect(tasks.finish(a.id, "done")).toMatchObject({ ok: false });
    expect(tasks.start(b.id)).toMatchObject({ ok: true });
    expect(tasks.finish(b.id, "cancelled")).toEqual({ ok: true });
    expect(tasks.describe()).toBe("No tasks waiting.");
  });

  it("come back paused after a restart, and are not carried on by themselves", () => {
    const path = file();
    const first = new AgentStore(path);
    const t = new Tasks(first);
    const a = t.add("update the report");
    t.start(a.id);
    first.close();
    const second = new AgentStore(path);
    const after = new Tasks(second);
    after.resumeAfterRestart();
    expect(after.list()[0]).toMatchObject({ state: "paused", note: "paused by a restart" });
    expect(after.current()).toBeNull();
    expect(after.start(a.id)).toMatchObject({ ok: true }); // only when asked again
  });
});

describe("the status a PC always keeps", () => {
  function rig() {
    const c = clock();
    const store = new AgentStore(file());
    const pushed: string[] = [];
    const status = new StatusKeeper({ store, push: (s) => pushed.push(`${s.state}|${s.task ?? ""}|${s.last ?? ""}`), now: c.now, setTimer: c.setTimer });
    return { c, store, status, pushed };
  }

  it("is pushed and saved when it changes, and not when it does not", () => {
    const r = rig();
    r.status.set({ state: "controlling", task: "update the report" });
    r.status.set({ state: "controlling", task: "update the report" });
    r.status.set({ last: "typed in Notepad" });
    expect(r.pushed).toEqual(["controlling|update the report|", "controlling|update the report|typed in Notepad"]);
    expect(r.store.status()).toMatchObject({ state: "controlling", last: "typed in Notepad" });
  });

  it("goes out again every 15 seconds so Friend always has a fresh one", () => {
    const r = rig();
    r.status.start();
    r.c.advance(46_000);
    expect(r.pushed).toHaveLength(3);
    r.status.stop();
    r.c.advance(60_000);
    expect(r.pushed).toHaveLength(3);
  });

  it("starts as idle after a restart, even if the last record said it was controlling", () => {
    const c = clock();
    const store = new AgentStore(file());
    store.setStatus({ state: "controlling", task: "update the report", at: 5 });
    const status = new StatusKeeper({ store, push: () => {}, now: c.now, setTimer: c.setTimer });
    expect(status.current()).toMatchObject({ state: "idle", task: "update the report" });
  });
});
