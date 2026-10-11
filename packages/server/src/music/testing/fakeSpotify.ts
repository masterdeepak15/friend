/** A stand-in for accounts.spotify.com and api.spotify.com, for tests. It speaks just enough of the real thing and records every request. */
export interface FakeSpotify {
  fetch: typeof fetch;
  requests: { url: string; method: string; headers: Record<string, string>; body: string }[];
  /** What the next calls do. */
  premium: boolean;
  /** Seconds a new access token lives. */
  expiresIn: number;
  /** The code the token endpoint will accept once. */
  issueCode(): string;
  failToken: boolean;
  rateLimit: boolean;
  garbage: boolean;
  /** Answer the next API call with 401 once (an access token that was revoked early). */
  unauthorizedOnce: boolean;
  tokensIssued: number;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

const TRACKS = [
  { id: "4uLU6hMCjMI75M1A2tKUQC", name: "Never Gonna Give You Up", artists: [{ name: "Rick Astley" }], album: { name: "Whenever You Need Somebody" }, duration_ms: 213000 },
  { id: "7qiZfU4dY1lWllzX7mPBI3", name: "Shape of You", artists: [{ name: "Ed Sheeran" }, { name: "Other" }], album: { name: "Divide" }, duration_ms: 233000 },
  { id: "0VjIjW4GlUZAMYd2vXMi3b", name: "Blinding Lights", artists: [{ name: "The Weeknd" }], album: { name: "After Hours" }, duration_ms: 200000 },
];

export function fakeSpotify(): FakeSpotify {
  const codes = new Set<string>();
  const live = new Map<string, "access" | "refresh">();
  let n = 0;
  const f: FakeSpotify = {
    requests: [],
    premium: true,
    expiresIn: 3600,
    failToken: false,
    rateLimit: false,
    garbage: false,
    unauthorizedOnce: false,
    tokensIssued: 0,
    issueCode: () => {
      const c = `code-${++n}`;
      codes.add(c);
      return c;
    },
    fetch: (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input);
      const headers = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), String(v)]));
      const body = typeof init?.body === "string" ? init.body : init?.body ? String(init.body) : "";
      f.requests.push({ url, method: init?.method ?? "GET", headers, body });
      const u = new URL(url);
      if (u.host === "accounts.spotify.com" && u.pathname === "/api/token") {
        if (f.failToken) return json(400, { error: "invalid_grant", error_description: "bad" });
        const p = new URLSearchParams(body);
        if (p.get("grant_type") === "authorization_code") {
          const code = p.get("code") ?? "";
          if (!codes.delete(code) || !p.get("code_verifier") || !p.get("client_id")) return json(400, { error: "invalid_grant" });
        } else if (p.get("grant_type") === "refresh_token") {
          if (live.get(p.get("refresh_token") ?? "") !== "refresh") return json(400, { error: "invalid_grant" });
        } else return json(400, { error: "unsupported_grant_type" });
        const access = `AT-${++f.tokensIssued}`;
        const refresh = `RT-${f.tokensIssued}`;
        live.set(access, "access");
        live.set(refresh, "refresh");
        return json(200, { access_token: access, refresh_token: refresh, expires_in: f.expiresIn, token_type: "Bearer", scope: "x" });
      }
      if (u.host !== "api.spotify.com") return json(404, {});
      if (f.rateLimit) return json(429, { error: { status: 429 } }, { "retry-after": "30" });
      if (f.garbage) return new Response("<html>oops</html>", { status: 200, headers: { "content-type": "text/html" } });
      if (f.unauthorizedOnce) {
        f.unauthorizedOnce = false;
        return json(401, { error: { status: 401, message: "The access token expired" } });
      }
      const auth = (headers.authorization ?? "").replace(/^Bearer /, "");
      if (live.get(auth) !== "access") return json(401, { error: { status: 401 } });
      if (u.pathname === "/v1/me") return json(200, { id: "user1", display_name: "Test Listener", product: f.premium ? "premium" : "free" });
      if (u.pathname === "/v1/search") {
        const limit = Number(u.searchParams.get("limit") ?? 20);
        return json(200, { tracks: { items: TRACKS.slice(0, limit) } });
      }
      if (u.pathname === "/v1/me/playlists") return json(200, { items: [{ id: "pl1", name: "Road trip", tracks: { total: 2 } }] });
      if (u.pathname === "/v1/playlists/pl1/tracks") return json(200, { items: TRACKS.slice(0, 2).map((t) => ({ track: t })) });
      const one = /^\/v1\/tracks\/([A-Za-z0-9]+)$/.exec(u.pathname);
      if (one) {
        const t = TRACKS.find((x) => x.id === one[1]);
        return t ? json(200, t) : json(404, { error: { status: 404 } });
      }
      return json(404, {});
    }) as typeof fetch,
  };
  return f;
}
