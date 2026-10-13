import type { WebConfig } from "../config";
import { extractText } from "./extract";
import type { Fetched } from "./fetch";
import { brave, duckDuckGo, searxng, tavily } from "./providers";
import { UNTRUSTED, type Choice } from "./search";

export interface WebToolDeps {
  /** Read each time, so switching it off in Settings applies at once. */
  enabled(): boolean;
  search(query: string, count?: number, signal?: AbortSignal): Promise<{ ok: boolean; text: string }>;
  fetch(url: string, signal?: AbortSignal): Promise<Fetched>;
  /** A page was read: only the site is recorded, never the whole address. */
  audit(entry: { host: string }): void;
}

const OFF = "Web search is switched off.";
const READ_LIMIT = 12_000;

/** Runs `web.search` or `web.read` for the model. Whatever comes back from the internet is marked as untrusted data. */
export async function runWebTool(name: string, args: unknown, d: WebToolDeps, signal?: AbortSignal): Promise<{ ok: boolean; text: string }> {
  if (!d.enabled()) return { ok: false, text: OFF };
  const a = (args && typeof args === "object" ? args : {}) as Record<string, unknown>;

  if (name === "web.search") {
    if (typeof a.query !== "string" || !a.query.trim()) return { ok: false, text: "Give a question to search for." };
    return d.search(a.query, typeof a.count === "number" ? a.count : undefined, signal);
  }

  if (name === "web.read") {
    if (typeof a.url !== "string" || !a.url.trim()) return { ok: false, text: "Give the address of the page to read." };
    const page = await d.fetch(a.url, signal);
    if (!page.ok) return { ok: false, text: page.error };
    try {
      d.audit({ host: new URL(page.finalUrl).hostname });
    } catch {
      /* the address was vetted already; nothing to record */
    }
    const { title, text, cut } = extractText(page.body, READ_LIMIT);
    const body = text ? `${text}${cut ? `\n(cut: ${cut} more characters)` : ""}` : "The page had no readable text.";
    return { ok: true, text: [UNTRUSTED, `Title: ${title || "(none)"}`, `Address: ${page.finalUrl}`, body].join("\n") };
  }

  return { ok: false, text: "That web tool does not exist." };
}

/** The search source the owner picked in Settings, or what is missing for it. */
export function chooseSearch(w: WebConfig): Choice {
  switch (w.provider) {
    case "brave":
      return w.braveKey ? brave(w.braveKey) : { needsKey: "Brave" };
    case "tavily":
      return w.tavilyKey ? tavily(w.tavilyKey) : { needsKey: "Tavily" };
    case "searxng":
      return w.searxngUrl ? searxng(w.searxngUrl) : { needsKey: "SearXNG", what: "address" };
    default:
      return duckDuckGo();
  }
}
