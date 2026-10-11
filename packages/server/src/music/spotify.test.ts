import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MusicTokens } from "./oauth";
import { SpotifyHub } from "./spotify";
import { fakeSpotify } from "./testing/fakeSpotify";

const CLIENT = "abc123DEF456ghi789";

function setup(over: { clientId?: string; enabled?: boolean; base?: string } = {}) {
  const fake = fakeSpotify();
  const tokens = new MusicTokens(mkdtempSync(join(tmpdir(), "friend-spotify-")));
  let now = 1_000_000;
  const config = { music: { spotify: { installed: true, enabled: over.enabled ?? true, clientId: over.clientId ?? CLIENT } } };
  const hub = new SpotifyHub({ config: () => config as never, tokens, fetch: fake.fetch, clock: () => now, publicBase: () => over.base ?? "https://friend.example.com" });
  const url = () => new URL(hub.connectUrl()!);
  const login = async () => {
    const state = url().searchParams.get("state")!;
    return hub.completeLogin({ code: fake.issueCode(), state });
  };
  return { fake, tokens, hub, url, login, tick: (ms: number) => (now += ms) };
}

describe("connecting", () => {
  it("builds the authorize address with PKCE, the derived redirect address and a fresh state", () => {
    const { hub, url } = setup();
    const u = url();
    expect(u.origin + u.pathname).toBe("https://accounts.spotify.com/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe(CLIENT);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("redirect_uri")).toBe("https://friend.example.com/api/music/oauth/callback");
    expect(u.searchParams.get("scope")).toContain("streaming");
    expect(hub.redirectUri()).toBe("https://friend.example.com/api/music/oauth/callback");
    expect(url().searchParams.get("state")).not.toBe(u.searchParams.get("state"));
  });

  it("uses the loopback address when there is no public address, never localhost", () => {
    const { hub } = setup({ base: "http://127.0.0.1:8787" });
    expect(hub.redirectUri()).toBe("http://127.0.0.1:8787/api/music/oauth/callback");
  });

  it("has no connect address without a client id", () => {
    expect(setup({ clientId: "" }).hub.connectUrl()).toBeNull();
  });

  it("finishes the login: keeps the tokens and the account, and says who is connected", async () => {
    const s = setup();
    expect(await s.login()).toEqual({ ok: true });
    expect(s.tokens.load("spotify")).toMatchObject({ account: "Test Listener", premium: true });
    expect(s.hub.status()).toMatchObject({ connected: true, account: "Test Listener", needs: null });
    const body = new URLSearchParams(s.fake.requests.find((r) => r.url.includes("/api/token"))!.body);
    expect(body.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(body.get("client_id")).toBe(CLIENT);
  });

  it("refuses a state Friend did not issue, a replayed one and an expired one, changing nothing", async () => {
    const s = setup();
    expect(await s.hub.completeLogin({ code: s.fake.issueCode(), state: "made-up" })).toMatchObject({ ok: false });
    const state = s.url().searchParams.get("state")!;
    expect(await s.hub.completeLogin({ code: s.fake.issueCode(), state })).toEqual({ ok: true });
    s.tokens.forget("spotify");
    expect(await s.hub.completeLogin({ code: s.fake.issueCode(), state })).toMatchObject({ ok: false });
    expect(s.tokens.load("spotify")).toBeNull();
    const old = s.url().searchParams.get("state")!;
    s.tick(11 * 60_000);
    expect(await s.hub.completeLogin({ code: s.fake.issueCode(), state: old })).toMatchObject({ ok: false });
    expect(s.tokens.load("spotify")).toBeNull();
  });

  it("says plainly when the owner did not allow it", async () => {
    const s = setup();
    const state = s.url().searchParams.get("state")!;
    const r = await s.hub.completeLogin({ error: "access_denied", state });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/did not allow/i) });
  });

  it("says plainly when Spotify refuses the code", async () => {
    const s = setup();
    const state = s.url().searchParams.get("state")!;
    const r = await s.hub.completeLogin({ code: "never-issued", state });
    expect(r).toMatchObject({ ok: false });
    expect(JSON.stringify(r)).not.toMatch(/code_verifier|AT-|RT-/);
  });

  it("disconnecting forgets the login", async () => {
    const s = setup();
    await s.login();
    s.hub.disconnect();
    expect(s.tokens.load("spotify")).toBeNull();
    expect(s.hub.status().connected).toBe(false);
  });
});

describe("what the owner is told they need", () => {
  it("not switched on, no client id, not connected, free account, reconnect", async () => {
    expect(setup({ enabled: false }).hub.status()).toMatchObject({ connected: false, needs: expect.stringMatching(/Plugins/) });
    expect(setup({ clientId: "" }).hub.status().needs).toMatch(/client id/i);
    expect(setup().hub.status().needs).toMatch(/Connect your Spotify/);
    const free = setup();
    free.fake.premium = false;
    await free.login();
    expect(free.hub.status()).toMatchObject({ connected: true, needs: expect.stringMatching(/Premium/) });
    const gone = setup();
    await gone.login();
    gone.tokens.markReconnect("spotify");
    expect(gone.hub.status()).toMatchObject({ connected: false, needs: expect.stringMatching(/Reconnect/) });
  });
});

describe("reading Spotify", () => {
  it("searches and gives spotify: refs, honouring the limit", async () => {
    const s = setup();
    await s.login();
    const t = await s.hub.search("never", 2);
    expect(t).toHaveLength(2);
    expect(t[0]).toEqual({ ref: "spotify:4uLU6hMCjMI75M1A2tKUQC", source: "spotify", title: "Never Gonna Give You Up", artist: "Rick Astley", album: "Whenever You Need Somebody", durationSec: 213 });
    expect(t[1]!.artist).toBe("Ed Sheeran, Other");
  });

  it("lists playlists, their tracks and one track", async () => {
    const s = setup();
    await s.login();
    expect(await s.hub.playlists(5)).toEqual([{ id: "pl1", name: "Road trip", tracks: 2 }]);
    expect((await s.hub.tracksOf("pl1", 5)).map((x) => x.ref)).toEqual(["spotify:4uLU6hMCjMI75M1A2tKUQC", "spotify:7qiZfU4dY1lWllzX7mPBI3"]);
    expect((await s.hub.track("0VjIjW4GlUZAMYd2vXMi3b"))?.title).toBe("Blinding Lights");
    expect(await s.hub.track("nope")).toBeNull();
    await expect(s.hub.tracksOf("../../x", 5)).rejects.toThrow();
  });

  it("renews the login when a token is revoked early, once, and carries on", async () => {
    const s = setup();
    await s.login();
    s.fake.unauthorizedOnce = true;
    expect(await s.hub.search("x", 1)).toHaveLength(1);
    expect(s.fake.requests.filter((r) => r.body.includes("grant_type=refresh_token"))).toHaveLength(1);
  });

  it("renews a token that is about to run out", async () => {
    const s = setup();
    await s.login();
    s.tick(3600_000 - 30_000);
    await s.hub.search("x", 1);
    expect(s.fake.requests.filter((r) => r.body.includes("grant_type=refresh_token"))).toHaveLength(1);
  });

  it("a rate limit and a page that is not JSON each give one plain sentence and no second try", async () => {
    const s = setup();
    await s.login();
    const before = () => s.fake.requests.length;
    s.fake.rateLimit = true;
    let n = before();
    await expect(s.hub.search("x", 1)).rejects.toThrow(/slow down/i);
    expect(before() - n).toBe(1);
    s.fake.rateLimit = false;
    s.fake.garbage = true;
    n = before();
    await expect(s.hub.search("x", 1)).rejects.toThrow(/did not answer/i);
    expect(before() - n).toBe(1);
  });

  it("when the renewal fails it asks the owner to reconnect and never loops", async () => {
    const s = setup();
    await s.login();
    s.fake.failToken = true;
    s.tick(3600_000);
    await expect(s.hub.search("x", 1)).rejects.toThrow(/reconnect/i);
    const n = s.fake.requests.length;
    await expect(s.hub.search("x", 1)).rejects.toThrow(/reconnect/i);
    expect(s.fake.requests.length).toBe(n);
    expect(s.hub.status().needs).toMatch(/Reconnect/);
  });

  it("only ever calls Spotify's own two hosts, and no message or request log shows a token", async () => {
    const s = setup();
    await s.login();
    await s.hub.search("x", 1);
    for (const r of s.fake.requests) expect(["accounts.spotify.com", "api.spotify.com"]).toContain(new URL(r.url).host);
    s.fake.rateLimit = true;
    const err = await s.hub.search("x", 1).catch((e: Error) => e.message);
    expect(String(err)).not.toMatch(/AT-\d|RT-\d/);
  });
});
