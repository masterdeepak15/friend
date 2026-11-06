import { describe, expect, it } from "vitest";
import { TurnQueue } from "./turnQueue";

/** A stand-in for the agent: busy while a "turn" runs, and calls the idle jobs when it ends. */
function fakeAgent() {
  let busy = false;
  const idle: (() => void)[] = [];
  return {
    busy: () => busy,
    whenIdle: (job: () => void) => (busy ? idle.push(job) : job()),
    start: () => {
      busy = true;
    },
    end: () => {
      busy = false;
      for (const j of idle.splice(0)) j();
    },
  };
}
const tick = () => new Promise((r) => setTimeout(r, 5));

describe("TurnQueue", () => {
  it("runs a job right away when she is free", async () => {
    const a = fakeAgent();
    const q = new TurnQueue(a);
    await expect(q.run(async () => 7)).resolves.toBe(7);
  });

  it("waits while she is busy, and never interrupts her", async () => {
    const a = fakeAgent();
    const q = new TurnQueue(a);
    a.start();
    let ran = false;
    const p = q.run(async () => {
      ran = true;
    });
    await tick();
    expect(ran).toBe(false);
    a.end();
    await p;
    expect(ran).toBe(true);
  });

  it("runs several one at a time, in order, and loses none of them", async () => {
    const a = fakeAgent();
    const q = new TurnQueue(a);
    a.start();
    const order: string[] = [];
    let overlap = 0;
    let worst = 0;
    const job = (name: string) => async () => {
      overlap++;
      worst = Math.max(worst, overlap);
      a.start(); // a real turn makes her busy
      await tick();
      order.push(name);
      overlap--;
      a.end();
    };
    const all = Promise.all([q.run(job("a")), q.run(job("b")), q.run(job("c"))]);
    a.end();
    await all;
    expect(order).toEqual(["a", "b", "c"]);
    expect(worst).toBe(1);
  });

  it("puts an urgent job before the waiting ones", async () => {
    const a = fakeAgent();
    const q = new TurnQueue(a);
    a.start();
    const order: string[] = [];
    const p = [q.run(async () => void order.push("note")), q.run(async () => void order.push("request"), true)];
    a.end();
    await Promise.all(p);
    expect(order).toEqual(["request", "note"]);
  });

  it("a failing job does not stop the ones after it", async () => {
    const a = fakeAgent();
    const q = new TurnQueue(a);
    const bad = q.run(async () => {
      throw new Error("boom");
    });
    const good = q.run(async () => "ok");
    await expect(bad).rejects.toThrow("boom");
    await expect(good).resolves.toBe("ok");
  });

  it("waits again if somebody else made her busy first", async () => {
    const a = fakeAgent();
    const q = new TurnQueue(a);
    a.start();
    let ran = false;
    const p = q.run(async () => void (ran = true));
    a.end();
    a.start(); // the owner's own request began in the same moment
    await tick();
    expect(ran).toBe(false);
    a.end();
    await p;
    expect(ran).toBe(true);
  });
});
