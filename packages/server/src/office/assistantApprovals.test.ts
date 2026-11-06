import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { TurnQueue } from "../agent/turnQueue";
import { openDb } from "../db";
import { AssistantApprovals, type AskInput } from "./assistantApprovals";
import { OfficeStore } from "./store";

const ask = (over: Partial<AskInput> = {}): AskInput => ({ workerId: "w1", worker: "Dev", job: "Developer", ticketId: 11, ticket: "Add login", goal: "Ship the site", tool: "Bash", action: "Run: npm install left-pad", danger: false, ...over });
const tick = () => new Promise((r) => setTimeout(r, 5));

function make(opts: { tries?: number; busy?: { v: boolean }; onTurn?: (text: string, a: AssistantApprovals, turn: number) => void } = {}) {
  const store = new OfficeStore(openDb(mkdtempSync(join(tmpdir(), "friend-assist-"))));
  const busy = opts.busy ?? { v: false };
  const idle: (() => void)[] = [];
  const queue = new TurnQueue({ busy: () => busy.v, whenIdle: (j) => (busy.v ? idle.push(j) : j()) });
  const audit = { log: vi.fn() };
  const texts: string[] = [];
  const holder: { a?: AssistantApprovals } = {};
  const a = new AssistantApprovals({
    store,
    queue,
    audit,
    tries: () => opts.tries ?? 3,
    runTurn: async (text) => {
      texts.push(text);
      busy.v = true;
      await tick();
      opts.onTurn?.(text, holder.a!, texts.length);
      busy.v = false;
      for (const j of idle.splice(0)) j();
    },
  });
  holder.a = a;
  return { a, store, texts, audit, busy, free: () => { busy.v = false; for (const j of idle.splice(0)) j(); } };
}
const idOf = (t: string) => Number(/Request #(\d+)/.exec(t)![1]);

describe("the assistant herself answers a worker's request", () => {
  it("writes it down, asks her with the facts and the worker's words marked as data, and gives her answer to the worker", async () => {
    const t = make({ onTurn: (text, a) => void a.decide(idOf(text), "allow", "Needed for the login ticket.") });
    const d = await t.a.request(ask());
    expect(d).toEqual({ kind: "allow", reason: "Needed for the login ticket." });
    expect(t.texts).toHaveLength(1);
    expect(t.texts[0]).toMatch(/Office approval, from the Office and not from the owner/);
    expect(t.texts[0]).toMatch(/Dev \(Developer\), ticket #11 "Add login", project goal "Ship the site"/);
    expect(t.texts[0]).toMatch(/<untrusted-worker-action>Run: npm install left-pad<\/untrusted-worker-action>/);
    expect(t.texts[0]).toMatch(/office\.decide/);
    expect(t.store.recentRequests()[0]).toMatchObject({ status: "allowed", decision: "allow", reason: "Needed for the login ticket.", tries: 1 });
  });

  it("a refusal and a pass to the owner are answers too", async () => {
    const t = make({ onTurn: (text, a) => void a.decide(idOf(text), text.includes("rm -rf") ? "deny" : "ask_owner", "because") });
    expect(await t.a.request(ask({ action: "Run: rm -rf build" }))).toEqual({ kind: "deny", reason: "because" });
    expect(await t.a.request(ask())).toEqual({ kind: "owner", reason: "because" });
  });

  it("waits while she is busy, and does not interrupt her", async () => {
    const busy = { v: true };
    const t = make({ busy, onTurn: (text, a) => void a.decide(idOf(text), "allow", "ok") });
    const p = t.a.request(ask());
    await tick();
    expect(t.texts).toHaveLength(0); // she is in the middle of something
    expect(t.store.pendingRequests()).toHaveLength(1); // but it is written down
    t.free();
    await expect(p).resolves.toMatchObject({ kind: "allow" });
    expect(t.texts).toHaveLength(1);
  });

  it("puts everything that piled up while she was busy to her in one go", async () => {
    const busy = { v: true };
    const t = make({
      busy,
      onTurn: (text, a) => {
        for (const m of text.matchAll(/Request #(\d+)/g)) a.decide(Number(m[1]), "allow", "ok");
      },
    });
    const ps = [t.a.request(ask({ workerId: "w1" })), t.a.request(ask({ workerId: "w2", worker: "Tess" }))];
    await tick();
    t.free();
    await Promise.all(ps);
    expect(t.texts).toHaveLength(1);
    expect(t.texts[0]).toMatch(/2 workers are paused/);
    expect(t.texts[0]).toMatch(/Dev/);
    expect(t.texts[0]).toMatch(/Tess/);
  });

  it("puts a request she left unanswered to her again, then to the owner: never allowed by silence", async () => {
    const t = make({ tries: 3 });
    const d = await t.a.request(ask());
    expect(d).toMatchObject({ kind: "owner" });
    expect(t.texts).toHaveLength(3);
    expect(t.texts[1]).toMatch(/asked again, you have not answered it yet; try 2/);
    expect(t.store.recentRequests()[0]).toMatchObject({ status: "owner", tries: 3 });
  });

  it("answers on the second try if she does it then", async () => {
    const t = make({ onTurn: (text, a, turn) => turn === 2 && void a.decide(idOf(text), "deny", "not needed") });
    expect(await t.a.request(ask())).toEqual({ kind: "deny", reason: "not needed" });
    expect(t.texts).toHaveLength(2);
  });

  it("refuses a second answer, an unknown number, and an answer after the worker was stopped", async () => {
    const t = make({ onTurn: (text, a) => void a.decide(idOf(text), "allow", "ok") });
    await t.a.request(ask());
    const id = t.store.recentRequests()[0]!.id;
    expect(t.a.decide(id, "deny", "late")).toMatchObject({ ok: false, error: expect.stringMatching(/already answered/) });
    expect(t.a.decide(999, "allow", "")).toMatchObject({ ok: false, error: expect.stringMatching(/no request #999/) });
    const stopped = make({ busy: { v: true } });
    const p = stopped.a.request(ask({ workerId: "w9" }));
    stopped.a.cancelWorker("w9");
    await expect(p).resolves.toEqual({ kind: "deny", reason: "The worker was stopped." });
    expect(stopped.store.recentRequests()[0]).toMatchObject({ status: "cancelled" });
  });

  it("keeps a record of every request and who answered it", async () => {
    const t = make({ onTurn: (text, a) => void a.decide(idOf(text), "allow", "ok") });
    await t.a.request(ask());
    expect(t.audit.log).toHaveBeenCalledWith("agent", "office.request", expect.objectContaining({ worker: "w1", tool: "Bash" }));
    expect(t.audit.log).toHaveBeenCalledWith("agent", "office.request_decided", expect.objectContaining({ status: "allowed", by: "assistant" }));
  });

  it("closes what was waiting when Friend restarts", () => {
    const t = make({ busy: { v: true } });
    void t.a.request(ask());
    expect(t.store.pendingRequests()).toHaveLength(1);
    t.store.resetRunning();
    expect(t.store.pendingRequests()).toHaveLength(0);
    expect(t.store.recentRequests()[0]).toMatchObject({ status: "cancelled", reason: "Friend restarted" });
  });
});
