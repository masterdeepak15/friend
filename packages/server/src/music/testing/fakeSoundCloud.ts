/** A stand-in for secure.soundcloud.com, api.soundcloud.com and the stream host, for tests. It speaks just enough of the real thing and records every request. */
export interface FakeSoundCloud {
  fetch: typeof fetch;
  requests: { url: string; method: string; headers: Record<string, string>; body: string }[];
  expiresIn: number;
  issueCode(): string;
  failToken: boolean;
  /** The token endpoint refuses a refresh with 400 (the login is no longer good). */
  rejectRefresh: boolean;
  rateLimit: boolean;
  garbage: boolean;
  hang: boolean;
  /** Where the stream address of every track points (to test the host check). */
  streamUrl: string;
  /** The stream host answers with a redirect to this address first. */
  redirectTo: string | null;
  tokensIssued: number;
  /** Ids of tracks whose access is "blocked" or "preview". */
  blocked: Set<number>;
  preview: Set<number>;
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });

export const SC_TRACKS = [
  { id: 1001, title: "Midnight City", user: { username: "M83 Official" }, duration: 243000, access: "playable" },
  { id: 1002, title: 'Quote "Me" 🎧', user: { username: "DJ Test" }, duration: 180500, access: "playable" },
  { id: 1003, title: "Locked Song", user: { username: "Label" }, duration: 200000, access: "blocked" },
  { id: 1004, title: "Preview Only", user: { username: "Label" }, duration: 150000, access: "preview" },
];

export function fakeSoundCloud(): FakeSoundCloud {
  const codes = new Set<string>();
  const live = new Map<string, "access" | "refresh">();
  let n = 0;
  const f: FakeSoundCloud = {
    requests: [],
    expiresIn: 3600,
    failToken: false,
    rejectRefresh: false,
    rateLimit: false,
    garbage: false,
    hang: false,
    streamUrl: "https://cf-media.sndcdn.com/track.mp3?sig=SECRETSIG",
    redirectTo: null,
    tokensIssued: 0,
    blocked: new Set(),
    preview: new Set(),
    issueCode() {
      const c = `code-${++n}`;
      codes.add(c);
      return c;
    },
    fetch: (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const u = new URL(url);
      const headers = Object.fromEntries(new Headers(init?.headers).entries());
      const body = typeof init?.body === "string" ? init.body : "";
      f.requests.push({ url, method: init?.method ?? "GET", headers, body });
      if (f.hang) return new Promise<Response>((_res, rej) => init?.signal?.addEventListener("abort", () => rej(new Error("aborted"))));
      if (u.host === "cf-media.sndcdn.com" || u.host === "evil.example.com") {
        if (f.redirectTo && u.host === "cf-media.sndcdn.com") return new Response(null, { status: 302, headers: { location: f.redirectTo } });
        const range = headers.range;
        return new Response("AUDIOBYTES", { status: range ? 206 : 200, headers: { "content-type": "audio/mpeg", ...(range ? { "content-range": "bytes 0-9/10" } : {}) } });
      }
      if (u.host === "secure.soundcloud.com" && u.pathname === "/oauth/token") {
        const p = new URLSearchParams(body);
        if (f.failToken) return json(500, {});
        if (p.get("grant_type") === "authorization_code") {
          if (!codes.delete(p.get("code") ?? "") || !p.get("code_verifier") || !p.get("client_secret")) return json(400, { error: "invalid_grant" });
        } else if (f.rejectRefresh || live.get(p.get("refresh_token") ?? "") !== "refresh") {
          return json(400, { error: "invalid_grant" });
        }
        f.tokensIssued++;
        const access = `at-${f.tokensIssued}`;
        const refresh = `rt-${f.tokensIssued}`;
        live.set(access, "access");
        live.set(refresh, "refresh");
        if (f.garbage) return new Response("<html>", { status: 200 });
        return json(200, { access_token: access, refresh_token: refresh, expires_in: f.expiresIn });
      }
      if (u.host !== "api.soundcloud.com") return new Response("no", { status: 404 });
      const auth = headers.authorization ?? "";
      if (live.get(auth.replace(/^OAuth /, "")) !== "access") return json(401, {});
      if (f.rateLimit) return json(429, {});
      if (f.garbage) return new Response("<html>", { status: 200 });
      const access = (t: (typeof SC_TRACKS)[number]) => (f.blocked.has(t.id) ? "blocked" : f.preview.has(t.id) ? "preview" : t.access);
      if (u.pathname === "/me") return json(200, { username: "Owner Name" });
      if (u.pathname === "/tracks") {
        const q = (u.searchParams.get("q") ?? "").toLowerCase();
        const lim = Number(u.searchParams.get("limit") ?? "10");
        return json(200, SC_TRACKS.map((t) => ({ ...t, access: access(t) })).filter((t) => t.title.toLowerCase().includes(q) || t.user.username.toLowerCase().includes(q)).slice(0, lim));
      }
      const streams = /^\/tracks\/(\d+)\/streams$/.exec(u.pathname);
      if (streams) {
        const t = SC_TRACKS.find((x) => x.id === Number(streams[1]));
        if (!t || access(t) !== "playable") return json(404, {});
        return json(200, { http_mp3_128_url: f.streamUrl, hls_mp3_128_url: "https://playback.media-streaming.soundcloud.cloud/x/playlist.m3u8" });
      }
      const one = /^\/tracks\/(\d+)$/.exec(u.pathname);
      if (one) {
        const t = SC_TRACKS.find((x) => x.id === Number(one[1]));
        return t ? json(200, { ...t, access: access(t) }) : json(404, {});
      }
      if (u.pathname === "/me/playlists") return json(200, [{ id: 77, title: "Road trip", track_count: 2 }]);
      if (u.pathname === "/playlists/77/tracks") return json(200, [SC_TRACKS[0], SC_TRACKS[1]]);
      return json(404, {});
    }) as unknown as typeof fetch,
  };
  return f;
}
