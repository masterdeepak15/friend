import { vetPublicUrl } from "../video/url";

export interface FetchOptions {
  /** Looks a name up (tests replace it). */
  resolve?: (host: string) => Promise<string[]>;
  /** The program that does the request (tests replace it). */
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  /** The most that is read from a page; the rest is never downloaded. */
  maxBytes?: number;
  maxRedirects?: number;
  signal?: AbortSignal;
}

export type Fetched = { ok: true; finalUrl: string; contentType: string; body: string } | { ok: false; error: string };

const TEXT_TYPES = new Set(["text/html", "application/xhtml+xml", "text/plain"]);
const NOTHING_DOWNLOADED = "Friend could not read that page.";

/**
 * Fetches one web page for the model to read, where a page can never lead Friend somewhere it should not go: every address,
 * including each stop on the way when the page redirects, must pass the public-address rule before a request is sent. Only text
 * pages are taken, a page that is too big is cut off while it downloads, nothing is run, and no cookie or login is sent. Every
 * failure is one plain sentence that never repeats an address.
 */
export async function safeFetch(url: string, o: FetchOptions = {}): Promise<Fetched> {
  const doFetch = o.fetchImpl ?? fetch;
  const maxBytes = o.maxBytes ?? 2_000_000;
  const maxRedirects = o.maxRedirects ?? 4;
  const control = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    control.abort();
  }, o.timeoutMs ?? 10_000);
  const onCallerAbort = () => control.abort();
  if (o.signal?.aborted) control.abort();
  o.signal?.addEventListener("abort", onCallerAbort, { once: true });

  try {
    let current = url;
    for (let redirects = 0; ; redirects++) {
      const vetted = await vetPublicUrl(current, { resolve: o.resolve });
      if (!vetted.ok) return { ok: false, error: vetted.error };
      control.signal.throwIfAborted();

      const res = await doFetch(vetted.url, {
        redirect: "manual",
        credentials: "omit",
        signal: control.signal,
        headers: { "user-agent": "Friend (personal assistant)", accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1" },
      });

      if (res.status >= 300 && res.status < 400) {
        const where = res.headers.get("location");
        await res.body?.cancel().catch(() => undefined);
        if (!where) return { ok: false, error: NOTHING_DOWNLOADED };
        if (redirects >= maxRedirects) return { ok: false, error: "That page sent Friend around too many times." };
        try {
          current = new URL(where, vetted.url).toString();
        } catch {
          return { ok: false, error: NOTHING_DOWNLOADED };
        }
        continue;
      }

      if (!res.ok) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, error: res.status === 404 ? "That page was not found." : `The site answered with an error (${res.status}).` };
      }

      const typeHeader = res.headers.get("content-type") ?? "";
      const type = typeHeader.split(";")[0]!.trim().toLowerCase();
      if (!TEXT_TYPES.has(type)) {
        await res.body?.cancel().catch(() => undefined);
        return { ok: false, error: "That link is not a text page, so Friend cannot read it." };
      }

      const bytes = await readCapped(res, maxBytes);
      return { ok: true, finalUrl: vetted.url, contentType: type, body: decode(bytes, typeHeader) };
    }
  } catch {
    return { ok: false, error: timedOut ? "That page took too long to answer." : o.signal?.aborted ? "The request was stopped." : NOTHING_DOWNLOADED };
  } finally {
    clearTimeout(timer);
    o.signal?.removeEventListener("abort", onCallerAbort);
  }
}

/** Reads at most `max` bytes and cancels the rest of the download. */
async function readCapped(res: Response, max: number): Promise<Uint8Array> {
  if (!res.body) return new Uint8Array();
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (total < max) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      total += value.length;
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  const out = new Uint8Array(Math.min(total, max));
  let at = 0;
  for (const c of chunks) {
    const take = Math.min(c.length, out.length - at);
    if (take <= 0) break;
    out.set(c.subarray(0, take), at);
    at += take;
  }
  return out;
}

function decode(bytes: Uint8Array, typeHeader: string): string {
  const charset = /charset=([\w-]+)/i.exec(typeHeader)?.[1] ?? "utf-8";
  try {
    return new TextDecoder(charset).decode(bytes);
  } catch {
    return new TextDecoder("utf-8").decode(bytes);
  }
}
