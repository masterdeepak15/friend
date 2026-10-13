import { describe, expect, it, vi } from "vitest";
import type { SearchHit, SearchProvider } from "./providers";
import { UNTRUSTED, webSearch } from "./search";

const hit = (n: number): SearchHit => ({ title: `Result ${n}`, url: `https://site${n}.example.com/page`, snippet: `Snippet ${n}` });
const source = (id: string, hits: SearchHit[] | Error): SearchProvider & { calls: number } => {
  const s = {
    id,
    calls: 0,
    async search() {
      s.calls++;
      if (hits instanceof Error) throw hits;
      return hits;
    },
  };
  return s;
};
const make = (chosen: SearchProvider | { needsKey: string }, fallback: SearchProvider, audit = vi.fn()) => ({ run: webSearch({ choose: () => chosen as never, fallback, audit }), audit });

describe("searching the web", () => {
  it("numbers the results, names the source, and marks it all as untrusted", async () => {
    const { run } = make(source("duckduckgo", [hit(1), hit(2)]), source("duckduckgo", []));
    const r = await run("nifty today");
    expect(r.ok).toBe(true);
    expect(r.text.startsWith(UNTRUSTED)).toBe(true);
    expect(r.text).toContain('Search results for "nifty today" (duckduckgo):');
    expect(r.text).toContain("1. Result 1 - https://site1.example.com/page (site1.example.com) - Snippet 1");
    expect(r.text).toContain("2. Result 2 - https://site2.example.com/page (site2.example.com) - Snippet 2");
  });

  it("asks for five results unless told otherwise", async () => {
    const asked: number[] = [];
    const s: SearchProvider = { id: "x", async search(_q, n) { asked.push(n); return []; } };
    const { run } = make(s, s);
    await run("a");
    await run("a", 3);
    expect(asked).toEqual([5, 3]);
  });

  it("says plainly when there is nothing", async () => {
    const { run } = make(source("duckduckgo", []), source("duckduckgo", []));
    expect(await run("zzzz")).toEqual({ ok: true, text: `${UNTRUSTED}\nNo results found for that search.` });
  });

  it("falls back to DuckDuckGo once when the chosen source fails, and says so", async () => {
    const chosen = source("brave", new Error("That key was refused."));
    const fb = source("duckduckgo", [hit(1)]);
    const { run } = make(chosen, fb);
    const r = await run("x");
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/brave could not be used .*duckduckgo was used/i);
    expect(r.text).toContain("Result 1");
    expect(chosen.calls).toBe(1);
    expect(fb.calls).toBe(1);
  });

  it("falls back when the source needs a key that is missing", async () => {
    const fb = source("duckduckgo", [hit(1)]);
    const { run } = make({ needsKey: "Brave" }, fb);
    const r = await run("x");
    expect(r.ok).toBe(true);
    expect(r.text).toMatch(/Brave needs a key/i);
    expect(r.text).toMatch(/Settings/);
    expect(fb.calls).toBe(1);
  });

  it("does not ask DuckDuckGo twice when it was the chosen source and it failed", async () => {
    const ddg = source("duckduckgo", new Error("blocked"));
    const { run } = make(ddg, ddg);
    const r = await run("x");
    expect(r.ok).toBe(false);
    expect(r.text).toMatch(/could not search/i);
    expect(ddg.calls).toBe(1);
  });

  it("gives up with one plain sentence when nothing works", async () => {
    const { run } = make(source("brave", new Error("down")), source("duckduckgo", new Error("blocked")));
    const r = await run("x");
    expect(r).toEqual({ ok: false, text: "I could not search the web just now. Say so instead of guessing an answer." });
  });

  it("writes the question, the source and how many results to the audit log", async () => {
    const { run, audit } = make(source("duckduckgo", [hit(1), hit(2)]), source("duckduckgo", []));
    await run("share market today");
    expect(audit).toHaveBeenCalledWith({ query: "share market today", source: "duckduckgo", results: 2 });
  });

  it("clips a very long question and ignores empty ones", async () => {
    const seen: string[] = [];
    const s: SearchProvider = { id: "x", async search(q) { seen.push(q); return []; } };
    const { run } = make(s, s);
    await run("  a   b\n c  ");
    expect(seen[0]).toBe("a b c");
    expect((await run("   ")).ok).toBe(false);
  });
});
