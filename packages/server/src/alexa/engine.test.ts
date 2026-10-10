import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AlexaEngine, type EngineDeps } from "./engine";
import { cleanSpeech, shortForVoice } from "./speech";
import type { AlexaRequestBody } from "./verify";

const intent = (name: string, slots: Record<string, string> = {}, locale = "en-IN"): AlexaRequestBody => ({
  version: "1.0",
  request: { type: "IntentRequest", timestamp: new Date().toISOString(), locale, intent: { name, slots: Object.fromEntries(Object.entries(slots).map(([k, v]) => [k, { value: v }])) } },
});
const plain = (type: string, locale = "en-IN"): AlexaRequestBody => ({ version: "1.0", request: { type, timestamp: new Date().toISOString(), locale } });

let now = 0;
const make = (over: Partial<EngineDeps> = {}) => {
  const ask = vi.fn(async (_t: string, _l: string, _d: string) => "It is fine.");
  const progressive = vi.fn();
  const deps: EngineDeps = { ask, fast: {}, clock: () => now, budgetMs: 40, holdMs: 600_000, progressive, ...over };
  return { engine: new AlexaEngine(deps), ask, progressive };
};
/** An answer that arrives when the test says so. */
const later = () => {
  let finish!: (s: string) => void;
  let fail!: (e: Error) => void;
  const promise = new Promise<string>((res, rej) => ((finish = res), (fail = rej)));
  return { promise, finish, fail };
};
beforeEach(() => {
  now = 1_000_000;
});
afterEach(() => vi.useRealTimers());

describe("opening and closing", () => {
  it("greets and keeps listening", async () => {
    const r = await make().engine.handle(plain("LaunchRequest"), "d1");
    expect(r.end).toBe(false);
    expect(r.speech.length).toBeGreaterThan(5);
    expect(r.reprompt).toBeTruthy();
  });

  it("ends quietly on session end, stop and cancel", async () => {
    const { engine } = make();
    for (const req of [plain("SessionEndedRequest"), intent("AMAZON.StopIntent"), intent("AMAZON.CancelIntent")]) {
      expect(await engine.handle(req, "d1")).toMatchObject({ speech: "", end: true });
    }
  });

  it("says what can be asked when helped, and that it did not understand an unknown intent", async () => {
    const { engine } = make();
    expect((await engine.handle(intent("AMAZON.HelpIntent"), "d1")).speech).toMatch(/portfolio/i);
    expect((await engine.handle(intent("SomethingElseIntent"), "d1")).speech).toMatch(/did not understand/i);
  });
});

describe("fixed questions", () => {
  it("are answered from the tools, without the assistant", async () => {
    const portfolio = vi.fn(async () => "Your portfolio is up 1.2 percent today.");
    const { engine, ask } = make({ fast: { PortfolioIntent: portfolio } });
    const r = await engine.handle(intent("PortfolioIntent"), "d1");
    expect(r).toMatchObject({ speech: "Your portfolio is up 1.2 percent today.", end: true });
    expect(ask).not.toHaveBeenCalled();
    expect(portfolio).toHaveBeenCalledWith("en-IN", {});
  });

  it("pass the slots along, and apologise briefly when a tool breaks", async () => {
    const weather = vi.fn(async (_l: string, s: Record<string, string>) => `Sunny in ${s.city}.`);
    const { engine } = make({ fast: { WeatherIntent: weather, TasksIntent: async () => { throw new Error("secret path C:\\x"); } } });
    expect((await engine.handle(intent("WeatherIntent", { city: "Pune" }), "d1")).speech).toBe("Sunny in Pune.");
    const bad = await engine.handle(intent("TasksIntent"), "d1");
    expect(bad.speech).toMatch(/could not/i);
    expect(bad.speech).not.toMatch(/secret|C:/);
  });

  it("say so when no tool is set up for that intent", async () => {
    const r = await make().engine.handle(intent("StatusIntent"), "d1");
    expect(r.speech).toMatch(/not available|cannot/i);
  });
});

describe("open questions", () => {
  it("rebuild the sentence from the lead-in and what was heard", async () => {
    const { engine, ask } = make();
    await engine.handle(intent("HowIntent", { q: "my portfolio is doing" }), "d1");
    expect(ask).toHaveBeenLastCalledWith("how my portfolio is doing", "en-IN", "d1");
    await engine.handle(intent("TellMeIntent", { q: "a joke" }), "d1");
    expect(ask).toHaveBeenLastCalledWith("tell me a joke", "en-IN", "d1");
    await engine.handle(intent("RemindMeIntent", { q: "to call mom at six" }), "d1");
    expect(ask).toHaveBeenLastCalledWith("remind me to call mom at six", "en-IN", "d1");
  });

  it("use the Hindi lead-ins in a Hindi locale", async () => {
    const { engine, ask } = make();
    await engine.handle(intent("HowIntent", { q: "मेरा पोर्टफोलियो है" }, "hi-IN"), "d1");
    expect(ask.mock.calls.at(-1)![0]).toBe("कैसे मेरा पोर्टफोलियो है");
    expect(ask.mock.calls.at(-1)![1]).toBe("hi-IN");
  });

  it("answer aloud, with a progressive 'let me check' first", async () => {
    const { engine, progressive } = make();
    const r = await engine.handle(intent("WhatIntent", { q: "is the time" }), "d1");
    expect(r).toMatchObject({ speech: "It is fine.", end: true });
    expect(progressive).toHaveBeenCalledTimes(1);
  });

  it("ask what was meant when nothing was heard", async () => {
    const { engine, ask } = make();
    const r = await engine.handle(intent("HowIntent", {}), "d1");
    expect(ask).not.toHaveBeenCalled();
    expect(r.end).toBe(false);
  });

  it("speak a short version and keep the whole text for the screen", async () => {
    const long = Array.from({ length: 12 }, (_, i) => `Sentence number ${i + 1} is here.`).join(" ");
    const { engine } = make({ ask: async () => long });
    const r = await engine.handle(intent("TellMeIntent", { q: "everything" }), "d1");
    expect(r.speech.length).toBeLessThanOrEqual(700);
    expect(r.full).toBe(cleanSpeech(long));
  });

  it("apologise briefly, without the error text, when the assistant fails", async () => {
    const { engine } = make({ ask: async () => { throw new Error("ECONNREFUSED 127.0.0.1:11434"); } });
    const r = await engine.handle(intent("HowIntent", { q: "it is" }), "d1");
    expect(r.speech).toMatch(/could not/i);
    expect(r.speech).not.toMatch(/ECONNREFUSED|127/);
  });
});

describe("answers that take too long", () => {
  it("say 'still working', and hand the answer over once, when asked if it is ready", async () => {
    const a = later();
    const { engine } = make({ ask: () => a.promise });
    const first = await engine.handle(intent("HowIntent", { q: "slow" }), "d1");
    expect(first).toMatchObject({ end: false });
    expect(first.speech).toMatch(/still working/i);
    expect((await engine.handle(intent("ReadyIntent"), "d1")).speech).toMatch(/still working/i);
    a.finish("Here you go.");
    await a.promise;
    await Promise.resolve();
    expect(await engine.handle(intent("ReadyIntent"), "d1")).toMatchObject({ speech: "Here you go.", end: true });
    expect((await engine.handle(intent("ReadyIntent"), "d1")).speech).toMatch(/nothing/i);
  });

  it("do not start a second question while one is still running", async () => {
    const a = later();
    const ask = vi.fn(() => a.promise);
    const { engine } = make({ ask });
    await engine.handle(intent("HowIntent", { q: "slow" }), "d1");
    const second = await engine.handle(intent("WhatIntent", { q: "else" }), "d1");
    expect(ask).toHaveBeenCalledTimes(1);
    expect(second.speech).toMatch(/still working/i);
  });

  it("keep each Echo's answer separate", async () => {
    const a = later();
    const { engine } = make({ ask: () => a.promise });
    await engine.handle(intent("HowIntent", { q: "slow" }), "kitchen");
    a.finish("Kitchen answer.");
    await a.promise;
    await Promise.resolve();
    expect((await engine.handle(intent("ReadyIntent"), "bedroom")).speech).toMatch(/nothing/i);
    expect((await engine.handle(intent("ReadyIntent"), "kitchen")).speech).toBe("Kitchen answer.");
  });

  it("forget a held answer after ten minutes", async () => {
    const a = later();
    const { engine } = make({ ask: () => a.promise });
    await engine.handle(intent("HowIntent", { q: "slow" }), "d1");
    a.finish("Old news.");
    await a.promise;
    await Promise.resolve();
    now += 600_001;
    expect((await engine.handle(intent("ReadyIntent"), "d1")).speech).toMatch(/nothing/i);
  });

  it("say it could not when the slow answer fails", async () => {
    const a = later();
    const { engine } = make({ ask: () => a.promise });
    await engine.handle(intent("HowIntent", { q: "slow" }), "d1");
    a.fail(new Error("boom"));
    await a.promise.catch(() => {});
    await Promise.resolve();
    expect((await engine.handle(intent("ReadyIntent"), "d1")).speech).toMatch(/could not/i);
  });
});

describe("what is spoken", () => {
  it("is plain: no markup, no ampersands, no line breaks, rupees and Devanagari kept", () => {
    const out = cleanSpeech("**Total** is ₹1,00,000 & <b>up</b>\n\n- INFY\n- TCS\n`code` नमस्ते");
    expect(out).not.toMatch(/[*`<>&\n]/);
    expect(out).toContain("₹1,00,000");
    expect(out).toContain("नमस्ते");
    expect(out).toContain("INFY");
  });

  it("is cut at a sentence end below the limit", () => {
    const text = Array.from({ length: 3000 }, () => "One more sentence.").join(" ");
    const out = cleanSpeech(text, 8000);
    expect(out.length).toBeLessThanOrEqual(8000);
    expect(out.endsWith(".")).toBe(true);
    expect(cleanSpeech(text).length).toBeLessThanOrEqual(8000);
  });

  it("has a short form of about three sentences", () => {
    const s = shortForVoice("One. Two. Three. Four. Five.");
    expect(s).toEqual({ spoken: "One. Two. Three.", truncated: true });
    expect(shortForVoice("Just one.")).toEqual({ spoken: "Just one.", truncated: false });
    expect(shortForVoice("x".repeat(2000)).spoken.length).toBeLessThanOrEqual(600);
  });
});
