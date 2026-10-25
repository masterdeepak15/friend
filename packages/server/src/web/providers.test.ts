import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { brave, duckDuckGo, searxng, tavily } from "./providers";

const FIX = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const signal = new AbortController().signal;

interface Seen {
  url: string;
  init: RequestInit;
}
function answer(body: string | object, status = 200, type = "application/json") {
  const seen: Seen[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push({ url: String(input), init: init ?? {} });
    return new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "content-type": type } });
  }) as typeof fetch;
  return { seen, fetchImpl };
}

describe("DuckDuckGo (no key)", () => {
  const page = readFileSync(join(FIX, "duckduckgo.html"), "utf8");

  it("reads the results of a real results page: title, the real address, a clean snippet", async () => {
    const a = answer(page, 200, "text/html");
    const hits = await duckDuckGo({ fetchImpl: a.fetchImpl }).search("nifty 50 today", 5, signal);
    expect(hits).toHaveLength(3);
    expect(hits[0]).toMatchObject({ title: "NSE - National Stock Exchange of India Ltd", url: "https://www.nseindia.com/" });
    expect(hits[0]!.snippet).toMatch(/^NSE India \(National Stock Exchange of India Ltd\) - LIVE Share\/Stock Market Updates Today\./);
    for (const h of hits) {
      expect(h.url).toMatch(/^https?:\/\//);
      expect(h.url).not.toContain("duckduckgo.com");
      expect(h.snippet).not.toMatch(/<|>/);
    }
  });

  it("drops advertisements", async () => {
    const hits = await duckDuckGo({ fetchImpl: answer(page, 200, "text/html").fetchImpl }).search("x", 10, signal);
    expect(hits.some((h) => /trading account|broker\.example/i.test(h.title + h.url))).toBe(false);
  });

  it("gives back no more than were asked for", async () => {
    const hits = await duckDuckGo({ fetchImpl: answer(page, 200, "text/html").fetchImpl }).search("x", 2, signal);
    expect(hits).toHaveLength(2);
  });

  it("asks politely: the query in the address, a plain user agent, no cookies", async () => {
    const a = answer(page, 200, "text/html");
    await duckDuckGo({ fetchImpl: a.fetchImpl }).search("sensex & nifty", 5, signal);
    const u = new URL(a.seen[0]!.url);
    expect(u.origin).toBe("https://html.duckduckgo.com");
    expect(u.searchParams.get("q")).toBe("sensex & nifty");
    expect(new Headers(a.seen[0]!.init.headers).get("user-agent")).toMatch(/^Friend/);
    expect(new Headers(a.seen[0]!.init.headers).get("cookie")).toBeNull();
  });

  it("returns nothing for a page with no results, and fails loudly when it was blocked", async () => {
    expect(await duckDuckGo({ fetchImpl: answer("<html><body><div class='no-results'>No results.</div></body></html>", 200, "text/html").fetchImpl }).search("zzzz", 5, signal)).toEqual([]);
    await expect(duckDuckGo({ fetchImpl: answer("<html><body><div class='anomaly-modal'>Unfortunately, bots use DuckDuckGo too.</div></body></html>", 200, "text/html").fetchImpl }).search("x", 5, signal)).rejects.toThrow(/blocked|too many/i);
    await expect(duckDuckGo({ fetchImpl: answer("busy", 429, "text/html").fetchImpl }).search("x", 5, signal)).rejects.toThrow();
    await expect(duckDuckGo({ fetchImpl: answer("oops", 500, "text/html").fetchImpl }).search("x", 5, signal)).rejects.toThrow();
  });
});

describe("Brave Search (key)", () => {
  const body = { web: { results: [{ title: "Nifty 50 - NSE", url: "https://www.nseindia.com/", description: "Live <strong>Nifty</strong> data" }, { title: "Bad", url: "javascript:alert(1)", description: "x" }, { title: "Second", url: "https://example.com/two", description: "two" }] } };

  it("sends the key in its header (never in the address) and reads the results", async () => {
    const a = answer(body);
    const hits = await brave("KEY123", { fetchImpl: a.fetchImpl }).search("nifty", 5, signal);
    expect(new Headers(a.seen[0]!.init.headers).get("x-subscription-token")).toBe("KEY123");
    expect(a.seen[0]!.url).not.toContain("KEY123");
    const u = new URL(a.seen[0]!.url);
    expect(u.origin + u.pathname).toBe("https://api.search.brave.com/res/v1/web/search");
    expect(u.searchParams.get("q")).toBe("nifty");
    expect(u.searchParams.get("count")).toBe("5");
    expect(hits).toEqual([
      { title: "Nifty 50 - NSE", url: "https://www.nseindia.com/", snippet: "Live Nifty data" },
      { title: "Second", url: "https://example.com/two", snippet: "two" },
    ]);
  });

  it("says plainly when the key is refused or the allowance is used up", async () => {
    await expect(brave("BAD", { fetchImpl: answer({}, 401).fetchImpl }).search("x", 5, signal)).rejects.toThrow(/key/i);
    await expect(brave("K", { fetchImpl: answer({}, 429).fetchImpl }).search("x", 5, signal)).rejects.toThrow(/limit|allowance|too many/i);
  });

  it("copes with an answer that has no web results", async () => {
    expect(await brave("K", { fetchImpl: answer({}).fetchImpl }).search("x", 5, signal)).toEqual([]);
  });
});

describe("Tavily (key)", () => {
  it("sends the key in its header and the question in the body, and reads the results", async () => {
    const a = answer({ results: [{ title: "Nifty today", url: "https://example.com/n", content: "Nifty closed at 22,363." }] });
    const hits = await tavily("TVLY", { fetchImpl: a.fetchImpl }).search("nifty", 3, signal);
    expect(a.seen[0]!.url).toBe("https://api.tavily.com/search");
    expect(a.seen[0]!.init.method).toBe("POST");
    expect(new Headers(a.seen[0]!.init.headers).get("authorization")).toBe("Bearer TVLY");
    expect(JSON.parse(String(a.seen[0]!.init.body))).toMatchObject({ query: "nifty", max_results: 3 });
    expect(a.seen[0]!.url).not.toContain("TVLY");
    expect(hits).toEqual([{ title: "Nifty today", url: "https://example.com/n", snippet: "Nifty closed at 22,363." }]);
  });

  it("says plainly when the key is refused", async () => {
    await expect(tavily("BAD", { fetchImpl: answer({}, 401).fetchImpl }).search("x", 5, signal)).rejects.toThrow(/key/i);
  });
});

describe("SearXNG (your own)", () => {
  it("asks your server for JSON and reads the results", async () => {
    const a = answer({ results: [{ title: "One", url: "https://example.com/1", content: "first" }, { title: "Two", url: "ftp://example.com/2", content: "second" }] });
    const hits = await searxng("http://localhost:8080/", { fetchImpl: a.fetchImpl }).search("nifty", 5, signal);
    const u = new URL(a.seen[0]!.url);
    expect(u.origin + u.pathname).toBe("http://localhost:8080/search");
    expect(u.searchParams.get("format")).toBe("json");
    expect(u.searchParams.get("q")).toBe("nifty");
    expect(hits).toEqual([{ title: "One", url: "https://example.com/1", snippet: "first" }]);
  });

  it("fails clearly when the server is not reachable", async () => {
    const fetchImpl = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    await expect(searxng("http://localhost:8080", { fetchImpl }).search("x", 5, signal)).rejects.toThrow();
  });
});

describe("every source", () => {
  it("tidies what comes back: one line, no markup, a sensible length, no repeated links", async () => {
    const long = "word ".repeat(200);
    const a = answer({ results: [{ title: "A\n\nB <b>bold</b>", url: "https://example.com/x", content: long }, { title: "Again", url: "https://example.com/x", content: "dup" }] });
    const hits = await tavily("K", { fetchImpl: a.fetchImpl }).search("x", 5, signal);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.title).toBe("A B bold");
    expect(hits[0]!.snippet.length).toBeLessThanOrEqual(301);
    expect(hits[0]!.snippet).not.toContain("\n");
  });
});

describe("Tavily (plugin options)", () => {
  it("sends the depth, topic, time range and site filters only when they are given", async () => {
    const a = answer({ results: [] });
    await tavily("K", { fetchImpl: a.fetchImpl, depth: "advanced" }).search("openai", 4, signal, { topic: "news", timeRange: "week", includeDomains: ["reuters.com"], excludeDomains: ["x.com"] });
    expect(JSON.parse(String(a.seen[0]!.init.body))).toEqual({ query: "openai", max_results: 4, search_depth: "advanced", topic: "news", time_range: "week", include_domains: ["reuters.com"], exclude_domains: ["x.com"] });
    const b = answer({ results: [] });
    await tavily("K", { fetchImpl: b.fetchImpl }).search("openai", 4, signal);
    expect(JSON.parse(String(b.seen[0]!.init.body))).toEqual({ query: "openai", max_results: 4, search_depth: "basic" });
  });
});
