/** A stand-in for api.audius.co and one of its content nodes, for tests. It speaks just enough of the real thing and records every request. */
export interface FakeAudius {
  fetch: typeof fetch;
  requests: { url: string; headers: Record<string, string> }[];
  rateLimit: boolean;
  garbage: boolean;
  hang: boolean;
  /** The API answers 200 and then never finishes sending the body. */
  stallBody: boolean;
  /** Where the stream endpoint redirects to. */
  node: string;
  /** The content node redirects again to this address first (a chain). */
  nodeRedirect: string | null;
}

const json = (status: number, body: unknown): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const user = { name: "Lofi Army" };
export const AUDIUS_TRACKS = [
  { id: "95wro", title: "Stars In The Sky - Lofi Beats", user, duration: 71, is_streamable: true, stream_conditions: null },
  { id: "aANABaw", title: 'Quote "Me" 🎧', user: { name: "DJ Test" }, duration: 247, is_streamable: true, stream_conditions: null },
  { id: "gated1", title: "Gated Song", user, duration: 100, is_streamable: true, stream_conditions: { usdc_purchase: { price: 100 } } },
  { id: "gone1", title: "Not Streamable", user, duration: 100, is_streamable: false, stream_conditions: null },
];

export function fakeAudius(): FakeAudius {
  const f: FakeAudius = {
    requests: [],
    rateLimit: false,
    garbage: false,
    hang: false,
    stallBody: false,
    node: "https://creatornode.audius.co/tracks/cidstream/QmAbc?signature=SECRETSIG&skip_play_count=true",
    nodeRedirect: null,
    fetch: (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const u = new URL(url);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      f.requests.push({ url, headers });
      if (f.hang) return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
      // the content nodes now answer with a redirect to object storage, whose address has another path
      if (u.pathname.startsWith("/tracks/cidstream/") || u.host.endsWith(".r2.cloudflarestorage.com")) {
        if (f.nodeRedirect && !u.searchParams.has("hop")) return new Response(null, { status: 302, headers: { location: f.nodeRedirect } });
        const range = headers.range;
        return new Response("AUDIOBYTES", { status: range ? 206 : 200, headers: { "content-type": "audio/mpeg", ...(range ? { "content-range": "bytes 0-9/10" } : {}) } });
      }
      if (u.host !== "api.audius.co") return new Response("no", { status: 404 });
      if (f.rateLimit) return json(429, {});
      if (f.garbage) return new Response("<html>", { status: 200 });
      if (f.stallBody) {
        const body = new ReadableStream({ start: (c) => init?.signal?.addEventListener("abort", () => c.error(new Error("aborted"))) });
        return new Response(body, { status: 200, headers: { "content-type": "application/json" } });
      }
      if (u.pathname === "/v1/tracks/search") {
        const q = (u.searchParams.get("query") ?? "").toLowerCase();
        const lim = Number(u.searchParams.get("limit") ?? "10");
        return json(200, { data: AUDIUS_TRACKS.filter((t) => t.title.toLowerCase().includes(q) || t.user.name.toLowerCase().includes(q)).slice(0, lim) });
      }
      const stream = /^\/v1\/tracks\/([A-Za-z0-9_-]+)\/stream$/.exec(u.pathname);
      if (stream) {
        const t = AUDIUS_TRACKS.find((x) => x.id === stream[1]);
        if (!t || !t.is_streamable || t.stream_conditions) return json(404, { code: 404, error: "track not found" });
        return new Response(null, { status: 302, headers: { location: f.node } });
      }
      const one = /^\/v1\/tracks\/([A-Za-z0-9_-]+)$/.exec(u.pathname);
      if (one) {
        const t = AUDIUS_TRACKS.find((x) => x.id === one[1]);
        return t ? json(200, { data: t }) : json(404, {});
      }
      return json(404, {});
    }) as unknown as typeof fetch,
  };
  return f;
}
