import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { Approvals } from "../approvals";
import { Audit } from "../audit";
import { Auth } from "../auth";
import { loadConfig } from "../config";
import { openDb } from "../db";
import { PolicyEngine } from "../policy/engine";
import type { Provider, ProviderEvent, StreamRequest } from "../provider/types";
import { StageState } from "../stage";
import { Agent } from "./loop";

/** A model that answers owner turns with a usage report, and summary requests (a guest, no tools) with a summary. */
class Model implements Provider {
  id = "scripted";
  calls: { kind: "turn" | "summary"; req: StreamRequest }[] = [];
  order: string[] = [];
  summaryFails = false;
  context = 150_000;
  canReset = true;
  resetSession?: (seed?: string) => Promise<void>;

  constructor(private summaryText = "Planning a trip to Goa.") {
    this.resetSession = async (seed) => {
      this.order.push(`reset:${seed ?? ""}`);
    };
  }
  async *stream(req: StreamRequest): AsyncGenerator<ProviderEvent> {
    const summary = req.session === "guest" && req.tools.length === 0;
    this.calls.push({ kind: summary ? "summary" : "turn", req });
    this.order.push(summary ? "summary" : "turn");
    if (summary) {
      if (this.summaryFails) {
        yield { type: "error", message: "no" };
        return;
      }
      yield { type: "text_delta", text: this.summaryText };
      yield { type: "done" };
      return;
    }
    yield { type: "text_delta", text: "Sure." };
    yield { type: "usage", input: 10, output: 5, context: this.context };
    yield { type: "done" };
  }
}

let db: ReturnType<typeof openDb>;
let build: (m: Provider, session?: { on: boolean; limit: number }, now?: () => number) => Agent;
let emitted: ServerMsg[];
const emit = (m: ServerMsg) => void emitted.push(m);
const ctx = (trust: "owner" | "guest" = "owner") => ({ trust, emit, ip: "9.9.9.9" });
const summaryAsk = (m: Model) => m.calls.filter((c) => c.kind === "summary");
const textOf = (r: StreamRequest) => r.messages.flatMap((x) => x.content.flatMap((b) => (b.type === "text" ? [b.text] : []))).join("\n");

beforeEach(async () => {
  emitted = [];
  const dir = mkdtempSync(join(tmpdir(), "friend-compact-"));
  db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
  const config = loadConfig(dir);
  const policy = new PolicyEngine(db, config);
  const approvals = new Approvals({ auth, policy, audit, db }, 150);
  build = (provider, session = { on: true, limit: 100_000 }, now = Date.now) =>
    new Agent({
      provider,
      policy,
      approvals,
      devices: { exec: async () => ({ ok: true, output: "", truncated: false }), hasOnline: () => true, targetName: () => "pc" } as never,
      stage: new StageState(),
      db,
      audit,
      config,
      assistantName: () => auth.assistantName(),
      session: { auto: () => session },
      tasks: { now } as never,
    });
});

describe("remembering how big the conversation is", () => {
  it("knows the size the model last reported", async () => {
    const m = new Model();
    const agent = build(m);
    expect(agent.contextTokens()).toBe(0);
    await agent.runTurn("hello", ctx());
    expect(agent.contextTokens()).toBe(150_000);
  });
});

describe("tidying up by itself", () => {
  it("summarizes and starts fresh before the next answer when the conversation got too big", async () => {
    const m = new Model();
    const agent = build(m);
    await agent.runTurn("let's plan a trip to Goa", ctx());
    m.order.length = 0;
    await agent.runTurn("what next?", ctx());
    expect(m.order).toEqual(["summary", "reset:Planning a trip to Goa.", "turn"]);
    expect(emitted.some((e) => e.type === "activity" && /memory/i.test(e.text ?? ""))).toBe(true);
  });

  it("gives the summariser the earlier words, not tool results", async () => {
    const m = new Model();
    const agent = build(m);
    await agent.runTurn("let's plan a trip to Goa", ctx());
    await agent.runTurn("what next?", ctx());
    const ask = summaryAsk(m)[0]!.req;
    expect(ask.session).toBe("guest");
    expect(ask.tools).toEqual([]);
    expect(textOf(ask)).toContain("let's plan a trip to Goa");
    expect(textOf(ask)).toContain("Sure.");
  });

  it("does nothing while the conversation is small", async () => {
    const m = new Model();
    m.context = 40_000;
    const agent = build(m);
    await agent.runTurn("a", ctx());
    await agent.runTurn("b", ctx());
    expect(m.order.filter((o) => o !== "turn")).toEqual([]);
  });

  it("does nothing when switched off, however big it is", async () => {
    const m = new Model();
    const agent = build(m, { on: false, limit: 100_000 });
    await agent.runTurn("a", ctx());
    await agent.runTurn("b", ctx());
    expect(m.order.filter((o) => o !== "turn")).toEqual([]);
  });

  it("uses the limit that is set now, not the one from when Friend started", async () => {
    const m = new Model();
    m.context = 150_000;
    const setting = { on: true, limit: 400_000 };
    const agent = build(m, setting);
    await agent.runTurn("a", ctx());
    await agent.runTurn("b", ctx());
    expect(m.order.some((o) => o.startsWith("reset"))).toBe(false);
    setting.limit = 100_000;
    await agent.runTurn("c", ctx());
    expect(m.order.some((o) => o.startsWith("reset"))).toBe(true);
  });

  it("does not tidy twice in a row: after a fresh start the size is not known until the model reports it", async () => {
    const m = new Model();
    m.context = 30_000;
    const agent = build(m);
    await agent.runTurn("a", { ...ctx() });
    // pretend the first answer was huge
    m.context = 150_000;
    await agent.runTurn("b", ctx());
    m.context = 30_000;
    await agent.runTurn("c", ctx()); // tidies (b reported 150K), then reports 30K
    await agent.runTurn("d", ctx());
    expect(m.order.filter((o) => o.startsWith("reset"))).toHaveLength(1);
  });

  it("never tidies because of a guest or a stranger, and does not touch the owner's conversation for them", async () => {
    const m = new Model();
    const agent = build(m);
    await agent.runTurn("a", ctx());
    await agent.runTurn("hello from a stranger", ctx("guest"));
    expect(m.order.some((o) => o.startsWith("reset"))).toBe(false);
  });

  it("carries the older summary into the next one, so nothing from long ago is lost", async () => {
    const m = new Model("First summary: Goa trip.");
    const agent = build(m);
    await agent.runTurn("a", ctx());
    await agent.runTurn("b", ctx()); // first tidy-up
    m.context = 150_000;
    await agent.runTurn("c", ctx());
    await agent.runTurn("d", ctx()); // second
    expect(textOf(summaryAsk(m)[1]!.req)).toContain("First summary: Goa trip.");
  });

  it("keeps the conversation and tries again later when the summary could not be made", async () => {
    const m = new Model();
    m.summaryFails = true;
    let now = 1_000_000;
    const agent = build(m, undefined, () => now);
    await agent.runTurn("a", ctx());
    await agent.runTurn("b", ctx()); // tries, fails, carries on with the old conversation
    expect(m.order.some((o) => o.startsWith("reset"))).toBe(false);
    expect(m.order.at(-1)).toBe("turn");
    const asks = summaryAsk(m).length;
    await agent.runTurn("c", ctx()); // too soon to try again
    expect(summaryAsk(m)).toHaveLength(asks);
    now += 11 * 60_000;
    m.summaryFails = false;
    await agent.runTurn("d", ctx());
    expect(m.order.some((o) => o.startsWith("reset"))).toBe(true);
  });

  it("is quietly skipped by a model that keeps no conversation of its own", async () => {
    const m = new Model();
    m.resetSession = undefined;
    const agent = build(m);
    await agent.runTurn("a", ctx());
    await agent.runTurn("b", ctx());
    expect(summaryAsk(m)).toHaveLength(0);
  });
});

describe("on request", () => {
  it("compacts now, and then does not need to again", async () => {
    const m = new Model();
    const agent = build(m);
    await agent.runTurn("let's plan a trip to Goa", ctx());
    const r = await agent.compact();
    expect(r).toMatchObject({ ok: true });
    expect(m.order).toContain("reset:Planning a trip to Goa.");
    expect(agent.contextTokens()).toBe(0);
    m.order.length = 0;
    await agent.runTurn("what next?", ctx());
    expect(m.order).toEqual(["turn"]);
  });

  it("says plainly when there is nothing to compact", async () => {
    const m = new Model();
    const agent = build(m);
    const r = await agent.compact();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/nothing/i);
  });

  it("says when the summary could not be made, and keeps the conversation", async () => {
    const m = new Model();
    const agent = build(m);
    await agent.runTurn("a", ctx());
    m.summaryFails = true;
    const r = await agent.compact();
    expect(r.ok).toBe(false);
    expect(m.order.some((o) => o.startsWith("reset"))).toBe(false);
    expect(agent.contextTokens()).toBe(150_000);
  });

  it("starts completely fresh with clear: no summary at all", async () => {
    const m = new Model();
    const agent = build(m);
    await agent.runTurn("a", ctx());
    const r = await agent.clear();
    expect(r.ok).toBe(true);
    expect(m.order.at(-1)).toBe("reset:");
    expect(summaryAsk(m)).toHaveLength(0);
    expect(agent.contextTokens()).toBe(0);
  });

  it("forgets the older summary on clear, so the next tidy-up does not bring it back", async () => {
    const m = new Model("Old summary: Goa trip.");
    const agent = build(m);
    await agent.runTurn("a", ctx());
    await agent.compact();
    await agent.clear();
    m.context = 150_000;
    await agent.runTurn("b", ctx());
    await agent.compact();
    expect(textOf(summaryAsk(m).at(-1)!.req)).not.toContain("Old summary");
  });

  it("explains that this model has no conversation of its own to tidy", async () => {
    const m = new Model();
    m.resetSession = undefined;
    const agent = build(m);
    await agent.runTurn("a", ctx());
    expect((await agent.compact()).message).toMatch(/does not keep/i);
    expect((await agent.clear()).message).toMatch(/does not keep/i);
  });

  it("refuses while Friend is busy answering", async () => {
    const m = new Model();
    const agent = build(m);
    const running = agent.runTurn("a", ctx());
    const r = await agent.compact();
    await running;
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/busy/i);
  });
});
