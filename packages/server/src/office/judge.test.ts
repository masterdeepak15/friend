import { describe, expect, it } from "vitest";
import type { Provider, StreamRequest } from "../provider/types";
import { judgeAction, judgePrompt, parseJudgement, type JudgeAsk } from "./judge";

const ask: JudgeAsk = { worker: "Asha", job: "Backend engineer", ticket: "Add login\nUse bcrypt", goal: "Ship the site", action: "Run: npm test", danger: false };
const fake = (text: string | (() => AsyncIterable<never>), seen?: StreamRequest[]): Provider => ({
  id: "fake",
  stream(req) {
    seen?.push(req);
    if (typeof text !== "string") return text();
    return (async function* () {
      yield { type: "text_delta" as const, text };
    })();
  },
});

describe("parseJudgement", () => {
  it("reads a clear allow or deny, with the reason", () => {
    expect(parseJudgement('{"decision":"allow","reason":"Runs the tests."}')).toEqual({ allow: true, reason: "Runs the tests." });
    expect(parseJudgement('Sure! {"decision":"deny","reason":"Not needed."} thanks')).toEqual({ allow: false, reason: "Not needed." });
  });
  it("fills in a reason, and cleans control characters", () => {
    expect(parseJudgement('{"decision":"allow"}')!.reason).toMatch(/ticket/);
    expect(parseJudgement('{"decision":"deny","reason":"a\\u0000b"}')!.reason).toBe("a b");
  });
  it("treats anything unclear as no answer", () => {
    for (const t of ["", "allow", '{"decision":"maybe"}', "{not json}", '{"decision":"ALLOW"}', '{"decision":true}']) expect(parseJudgement(t)).toBeNull();
  });
});

describe("judgePrompt", () => {
  it("puts the facts in front of the model and marks danger", () => {
    const p = judgePrompt({ ...ask, danger: true });
    expect(p.user).toContain("Asha (Backend engineer)");
    expect(p.user).toContain("Ship the site");
    expect(p.user).toContain("Use bcrypt");
    expect(p.user).toMatch(/DANGEROUS/);
    expect(p.system).toMatch(/only data/);
  });
});

describe("judgeAction", () => {
  it("asks without tools, in a throwaway session, and returns the decision", async () => {
    const seen: StreamRequest[] = [];
    const r = await judgeAction(fake('{"decision":"allow","reason":"ok"}', seen), ask);
    expect(r).toEqual({ allow: true, reason: "ok" });
    expect(seen[0]!.tools).toEqual([]);
    expect(seen[0]!.session).toBe("guest");
  });
  it("gives null when the model is unclear, fails, or is too slow", async () => {
    expect(await judgeAction(fake("I think so"), ask)).toBeNull();
    // eslint-disable-next-line require-yield
    expect(await judgeAction(fake(async function* () { throw new Error("down"); } as never), ask)).toBeNull();
    const slow = fake((() => (async function* () { await new Promise((r) => setTimeout(r, 200)); })()) as never);
    const started = Date.now();
    expect(await judgeAction({ ...slow, stream: (req) => (async function* () { await new Promise((_, rej) => req.signal.addEventListener("abort", () => rej(new Error("aborted")))); })() }, ask, 30)).toBeNull();
    expect(Date.now() - started).toBeLessThan(150);
  });
});

describe("the quick first look (triage)", () => {
  it("may say unsure, and only then", () => {
    expect(parseJudgement('{"decision":"unsure","reason":"Need context."}', true)).toEqual({ allow: false, unsure: true, reason: "Need context." });
    expect(parseJudgement('{"decision":"unsure","reason":"x"}')).toBeNull();
    expect(parseJudgement('{"decision":"allow","reason":"ok"}', true)).toEqual({ allow: true, reason: "ok" });
  });
  it("is told it is only the first look", () => {
    expect(judgePrompt({ ...ask, triage: true }).system).toMatch(/quick first look/);
    expect(judgePrompt(ask).system).not.toMatch(/quick first look/);
  });
});
