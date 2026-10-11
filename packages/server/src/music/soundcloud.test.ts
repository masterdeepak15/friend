import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MusicSecrets, MusicTokens } from "./oauth";
import { SoundCloudHub } from "./soundcloud";
import { fakeSoundCloud } from "./testing/fakeSoundCloud";

const CLIENT = "abc123DEF456ghi789jkl012MNO345pq";
const SECRET = "s3cr3t-value-xyz";

function setup(over: { clientId?: string; secret?: string; enabled?: boolean; requestTimeoutMs?: number } = {}) {
  const fake = fakeSoundCloud();
  const dir = mkdtempSync(join(tmpdir(), "friend-sc-"));
  const tokens = new MusicTokens(dir);
  const secrets = new MusicSecrets(dir);
  if (over.secret !== "") secrets.set("soundcloud", over.secret ?? SECRET);
  let now = 1_000_000;
  const config = { music: { soundcloud: { installed: true, enabled: over.enabled ?? true, clientId: over.clientId ?? CLIENT } } };
  const hub = new SoundCloudHub({ config: () => config as never, tokens, secrets, fetch: fake.fetch, clock: () => now, publicBase: () => "https://friend.example.com", ...(over.requestTimeoutMs ? { requestTimeoutMs: over.requestTimeoutMs } : {}) });
  const url = () => new URL(hub.connectUrl()!);
  const login = async () => hub.completeLogin({ code: fake.issueCode(), state: url().searchParams.get("state")! });
  return { fake, tokens, secrets, hub, url, login, dir, tick: (ms: number) => (now += ms) };
}

describe("connecting", () => {
  it("builds the authorize address with PKCE, the redirect address and a fresh state", () => {
    const { hub, url } = setup();
    const u = url();
    expect(u.origin + u.pathname).toBe("https://secure.soundcloud.com/authorize");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("client_id")).toBe(CLIENT);
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("code_challenge")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(u.searchParams.get("redirect_uri")).toBe("https://friend.example.com/api/music/oauth/callback");
    expect(hub.redirectUri()).toBe("https://friend.example.com/api/music/oauth/callback");
    expect(url().searchParams.get("state")).not.toBe(u.searchParams.get("state"));
    expect(u.toString()).not.toContain(SECRET);
  });

  it("has no connect address without a client id or a secret", () => {
    expect(setup({ clientId: "" }).hub.connectUrl()).toBeNull();
    expect(setup({ secret: "" }).hub.connectUrl()).toBeNull();
  });

  it("finishes the login, keeps the tokens and says who is connected", async () => {
    const s = setup();
    expect(await s.login()).toEqual({ ok: true });
    expect(s.hub.status()).toEqual({ connected: true, needs: null, account: "Owner Name" });
    const tokenCall = s.fake.requests.find((r) => r.url.endsWith("/oauth/token"))!;
    const p = new URLSearchParams(tokenCall.body);
    expect(p.get("client_secret")).toBe(SECRET);
    expect(p.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{64}$/);
  });

  it("accepts a state once only, and not after ten minutes", async () => {
    const s = setup();
    const state = s.url().searchParams.get("state")!;
    const code = s.fake.issueCode();
    expect(await s.hub.completeLogin({ code, state })).toEqual({ ok: true });
    expect((await s.hub.completeLogin({ code: s.fake.issueCode(), state })).ok).toBe(false);
    const late = s.url().searchParams.get("state")!;
    s.tick(11 * 60_000);
    expect((await s.hub.completeLogin({ code: s.fake.issueCode(), state: late })).ok).toBe(false);
  });

  it("says plainly when the owner refused, or SoundCloud sent no code", async () => {
    const s = setup();
    const r = await s.hub.completeLogin({ error: "access_denied", state: s.url().searchParams.get("state")! });
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/did not allow/i) });
    const r2 = await s.hub.completeLogin({ state: s.url().searchParams.get("state")! });
    expect(r2.ok).toBe(false);
  });

  it("keeps the secret out of every returned value and out of the token file", async () => {
    const s = setup();
    await s.login();
    expect(JSON.stringify(s.hub.status())).not.toContain(SECRET);
    expect(readFileSync(join(s.dir, "music-soundcloud.tokens.json"), "utf8")).not.toContain(SECRET);
    if (process.platform !== "win32") {
      expect(statSync(join(s.dir, "music-soundcloud.secret.json")).mode & 0o777).toBe(0o600);
    }
    expect(s.secrets.has("soundcloud")).toBe(true);
  });
});

describe("status", () => {
  it("tells the owner what is missing, in plain words", () => {
    expect(setup({ enabled: false }).hub.status()).toMatchObject({ connected: false, needs: expect.stringMatching(/install and switch on/i) });
    expect(setup({ clientId: "" }).hub.status().needs).toMatch(/client id/i);
    expect(setup({ secret: "" }).hub.status().needs).toMatch(/secret/i);
    expect(setup().hub.status().needs).toMatch(/connect your soundcloud/i);
  });
});

describe("keeping the login fresh", () => {
  it("renews a login that is about to end, once for simultaneous calls", async () => {
    const s = setup();
    s.fake.expiresIn = 120;
    await s.login();
    s.tick(100_000);
    const before = s.fake.tokensIssued;
    const [a, b] = await Promise.all([s.hub.accessToken(), s.hub.accessToken()]);
    expect(a).toBe(b);
    expect(s.fake.tokensIssued).toBe(before + 1);
  });

  it("marks reconnect when SoundCloud refuses the renewal, and stops asking", async () => {
    const s = setup();
    s.fake.expiresIn = 120;
    await s.login();
    s.fake.rejectRefresh = true;
    s.tick(100_000);
    expect(await s.hub.accessToken()).toBeNull();
    expect(s.hub.status()).toMatchObject({ connected: false, needs: expect.stringMatching(/reconnect soundcloud/i) });
    const calls = s.fake.requests.length;
    expect(await s.hub.accessToken()).toBeNull();
    expect(s.fake.requests.length).toBe(calls);
  });

  it("disconnect forgets the login but keeps the secret for connecting again", async () => {
    const s = setup();
    await s.login();
    s.hub.disconnect();
    expect(s.hub.status().connected).toBe(false);
    expect(s.secrets.has("soundcloud")).toBe(true);
  });
});

describe("searching", () => {
  it("returns playable tracks only, with refs, artist and seconds", async () => {
    const s = setup();
    await s.login();
    const all = await s.hub.search("", 10);
    expect(all.map((t) => t.ref)).toEqual(["soundcloud:1001", "soundcloud:1002"]);
    expect(all[0]).toEqual({ ref: "soundcloud:1001", source: "soundcloud", title: "Midnight City", artist: "M83 Official", album: "", durationSec: 243 });
  });

  it("keeps titles with quotes and emoji intact", async () => {
    const s = setup();
    await s.login();
    const [t] = await s.hub.search("quote", 5);
    expect(t!.title).toBe('Quote "Me" 🎧');
  });

  it("passes the query and limit, and uses the owner's login", async () => {
    const s = setup();
    await s.login();
    await s.hub.search("midnight", 3);
    const r = s.fake.requests.at(-1)!;
    expect(new URL(r.url).searchParams.get("q")).toBe("midnight");
    expect(new URL(r.url).searchParams.get("limit")).toBe("3");
    expect(r.headers.authorization).toMatch(/^OAuth at-/);
  });

  it("says the same thing in one sentence for a busy, broken or hung SoundCloud", async () => {
    const s = setup({ requestTimeoutMs: 100 });
    await s.login();
    s.fake.rateLimit = true;
    await expect(s.hub.search("x", 3)).rejects.toThrow(/slow down/i);
    s.fake.rateLimit = false;
    s.fake.garbage = true;
    await expect(s.hub.search("x", 3)).rejects.toThrow(/did not answer properly/i);
    s.fake.garbage = false;
    s.fake.hang = true;
    await expect(s.hub.search("x", 3)).rejects.toThrow(/could not reach/i);
  });

  it("asks for a connection before it has one", async () => {
    await expect(setup().hub.search("x", 3)).rejects.toThrow(/connect your soundcloud/i);
  });
});

describe("tracks and playlists", () => {
  it("finds one track by id, null for a blocked or unknown one, and refuses odd ids", async () => {
    const s = setup();
    await s.login();
    expect((await s.hub.track("1001"))?.title).toBe("Midnight City");
    expect(await s.hub.track("1003")).toBeNull();
    expect(await s.hub.track("9999")).toBeNull();
    expect(await s.hub.track("../me")).toBeNull();
  });

  it("lists the owner's playlists and their tracks", async () => {
    const s = setup();
    await s.login();
    expect(await s.hub.playlists(10)).toEqual([{ id: "77", name: "Road trip", tracks: 2 }]);
    expect((await s.hub.tracksOf("77", 10)).map((t) => t.ref)).toEqual(["soundcloud:1001", "soundcloud:1002"]);
    await expect(s.hub.tracksOf("../x", 10)).rejects.toThrow(/not a soundcloud playlist/i);
  });
});
