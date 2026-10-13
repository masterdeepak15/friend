import { decodeEntities } from "./extract";

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

/** A place to ask. Throws an Error whose message is a plain sentence when it cannot answer. */
export interface SearchProvider {
  id: string;
  search(query: string, count: number, signal: AbortSignal): Promise<SearchHit[]>;
}

interface Options {
  fetchImpl?: typeof fetch;
}

const AGENT = "Friend (personal assistant)";
const TITLE_MAX = 150;
const SNIPPET_MAX = 300;

const text = (raw: unknown, max: number): string => {
  const s = decodeEntities(String(raw ?? "").replace(/<\/?(?:b|strong|i|em|u|mark|span|a|small|sub|sup)\b[^>]*>/gi, "").replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  return s.length > max ? `${s.slice(0, max)}…` : s;
};

/** Only real web addresses, each once, no more than asked for, every field one tidy line. */
function tidy(rows: { title: unknown; url: unknown; snippet: unknown }[], count: number): SearchHit[] {
  const seen = new Set<string>();
  const out: SearchHit[] = [];
  for (const r of rows) {
    let u: URL;
    try {
      u = new URL(String(r.url ?? ""));
    } catch {
      continue;
    }
    if (u.protocol !== "http:" && u.protocol !== "https:") continue;
    const url = u.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    out.push({ title: text(r.title, TITLE_MAX) || u.hostname, url, snippet: text(r.snippet, SNIPPET_MAX) });
    if (out.length >= count) break;
  }
  return out;
}

async function get(f: typeof fetch, url: string, init: RequestInit, name: string, refused: string): Promise<Response> {
  let res: Response;
  try {
    res = await f(url, { credentials: "omit", ...init });
  } catch {
    throw new Error(`${name} could not be reached.`);
  }
  if (res.status === 401 || res.status === 403) throw new Error(refused);
  if (res.status === 429) throw new Error(`${name} says there were too many searches (the free allowance may be used up).`);
  if (!res.ok) throw new Error(`${name} answered with an error (${res.status}).`);
  return res;
}

const jsonOf = async (res: Response, name: string): Promise<Record<string, any>> => {
  try {
    return (await res.json()) as Record<string, any>;
  } catch {
    throw new Error(`${name} gave an answer Friend could not read.`);
  }
};

/** DuckDuckGo's plain results page: free, no key. It is a page made for people, so it can change or turn Friend away. */
export function duckDuckGo(o: Options = {}): SearchProvider {
  const f = o.fetchImpl ?? fetch;
  return {
    id: "duckduckgo",
    async search(query, count, signal) {
      const res = await get(f, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { signal, headers: { "user-agent": AGENT, accept: "text/html" } }, "DuckDuckGo", "DuckDuckGo blocked the search.");
      if (res.status !== 200) throw new Error("DuckDuckGo blocked the search (too many requests).");
      const html = await res.text();
      const rows: { title: string; url: string; snippet: string }[] = [];
      for (const block of html.split(/<div class="result\b/).slice(1)) {
        const head = block.slice(0, 200);
        if (/result--ad\b/.test(head) || /\bresult--ad\b/.test(block.slice(0, 400))) continue;
        const a = /<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block) ?? /<a[^>]*href="([^"]+)"[^>]*class="result__a"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
        if (!a) continue;
        const url = realAddress(decodeEntities(a[1]!));
        if (!url) continue;
        const s = /class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
        rows.push({ title: a[2]!, url, snippet: s?.[1] ?? "" });
      }
      const hits = tidy(rows, count);
      if (hits.length === 0 && /anomaly|captcha|unusual traffic/i.test(html)) throw new Error("DuckDuckGo blocked the search (too many requests).");
      return hits;
    },
  };
}

/** DuckDuckGo wraps each link as //duckduckgo.com/l/?uddg=<real address>; an advertisement points at duckduckgo.com itself. */
function realAddress(href: string): string | null {
  try {
    const u = new URL(href.startsWith("//") ? `https:${href}` : href);
    if (/(^|\.)duckduckgo\.com$/.test(u.hostname)) {
      const real = u.pathname.startsWith("/l/") ? u.searchParams.get("uddg") : null;
      return real && /^https?:\/\//i.test(real) ? real : null;
    }
    return u.toString();
  } catch {
    return null;
  }
}

/** Brave Search's own interface. Needs the owner's key, sent in a header. */
export function brave(key: string, o: Options = {}): SearchProvider {
  const f = o.fetchImpl ?? fetch;
  return {
    id: "brave",
    async search(query, count, signal) {
      const res = await get(f, `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`, { signal, headers: { accept: "application/json", "x-subscription-token": key, "user-agent": AGENT } }, "Brave", "Brave refused the key.");
      const body = await jsonOf(res, "Brave");
      const rows = Array.isArray(body.web?.results) ? body.web.results : [];
      return tidy(rows.map((r: any) => ({ title: r.title, url: r.url, snippet: r.description })), count);
    },
  };
}

/** Tavily's interface, made for assistants. Needs the owner's key, sent in a header. */
export function tavily(key: string, o: Options = {}): SearchProvider {
  const f = o.fetchImpl ?? fetch;
  return {
    id: "tavily",
    async search(query, count, signal) {
      const res = await get(f, "https://api.tavily.com/search", { method: "POST", signal, headers: { "content-type": "application/json", authorization: `Bearer ${key}`, "user-agent": AGENT }, body: JSON.stringify({ query, max_results: count, search_depth: "basic" }) }, "Tavily", "Tavily refused the key.");
      const body = await jsonOf(res, "Tavily");
      const rows = Array.isArray(body.results) ? body.results : [];
      return tidy(rows.map((r: any) => ({ title: r.title, url: r.url, snippet: r.content })), count);
    },
  };
}

/** The owner's own SearXNG server. */
export function searxng(baseUrl: string, o: Options = {}): SearchProvider {
  const f = o.fetchImpl ?? fetch;
  return {
    id: "searxng",
    async search(query, count, signal) {
      const url = new URL("search", baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
      url.searchParams.set("q", query);
      url.searchParams.set("format", "json");
      const res = await get(f, url.toString(), { signal, headers: { accept: "application/json", "user-agent": AGENT } }, "Your SearXNG server", "Your SearXNG server refused the search.");
      const body = await jsonOf(res, "Your SearXNG server");
      const rows = Array.isArray(body.results) ? body.results : [];
      return tidy(rows.map((r: any) => ({ title: r.title, url: r.url, snippet: r.content })), count);
    },
  };
}
