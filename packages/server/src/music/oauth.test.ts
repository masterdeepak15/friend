import { mkdtempSync, readFileSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { challengeOf, freshToken, MusicTokens, OAuthStates, pkcePair, RefreshRejected } from "./oauth";

const tokens = () => new MusicTokens(mkdtempSync(join(tmpdir(), "friend-musictok-")));
const saved = (over: Partial<{ accessToken: string; refreshToken: string; expiresAt: number; account: string; premium: boolean | null }> = {}) => ({ accessToken: "AT1", refreshToken: "RT1", expiresAt: 1_000_000, account: "me", premium: true, ...over });

describe("pkcePair", () => {
  it("makes the S256 challenge of the verifier (RFC 7636 test vector)", () => {
    const verifier = "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk";
    expect(challengeOf(verifier)).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
  it("gives a long random verifier and a different one each time", () => {
    const a = pkcePair();
    const b = pkcePair();
    expect(a.verifier).toMatch(/^[A-Za-z0-9_-]{43,128}$/);
    expect(a.verifier).not.toBe(b.verifier);
    expect(a.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });
});

describe("OAuthStates", () => {
  it("accepts a state once", () => {
    const s = new OAuthStates();
    const state = s.issue("spotify", "ver");
    expect(s.take(state)).toEqual({ source: "spotify", verifier: "ver" });
    expect(s.take(state)).toBeNull();
  });
  it("refuses an unknown or expired state", () => {
    let now = 0;
    const s = new OAuthStates(() => now);
    const state = s.issue("spotify", "ver");
    expect(s.take("nope")).toBeNull();
    now = 10 * 60_000 + 1;
    expect(s.take(state)).toBeNull();
  });
  it("keeps at most 20 pending, dropping the oldest", () => {
    let now = 0;
    const s = new OAuthStates(() => now++);
    const first = s.issue("spotify", "v0");
    for (let i = 1; i <= 20; i++) s.issue("spotify", `v${i}`);
    expect(s.take(first)).toBeNull();
  });
});

describe("MusicTokens", () => {
  it("saves, loads and forgets, in a file only the owner can read", () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-musictok-"));
    const t = new MusicTokens(dir);
    t.save("spotify", saved());
    expect(t.load("spotify")).toEqual(saved());
    const file = join(dir, readdirSync(dir)[0]!);
    expect(file).toMatch(/music-spotify\.tokens\.json$/);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
    expect(readFileSync(file, "utf8")).toContain("AT1");
    t.forget("spotify");
    expect(t.load("spotify")).toBeNull();
    expect(readdirSync(dir)).toEqual([]);
  });
  it("treats a damaged file as no login", () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-musictok-"));
    const t = new MusicTokens(dir);
    t.save("spotify", saved());
    require("node:fs").writeFileSync(join(dir, "music-spotify.tokens.json"), "{not json");
    expect(t.load("spotify")).toBeNull();
  });
});

describe("freshToken", () => {
  it("returns the saved token while it has more than a minute left, without refreshing", async () => {
    const t = tokens();
    t.save("spotify", saved({ expiresAt: 1_000_000 }));
    let calls = 0;
    const got = await freshToken("spotify", t, async () => { calls++; return { accessToken: "AT2", expiresAt: 9 }; }, () => 1_000_000 - 61_000);
    expect(got).toBe("AT1");
    expect(calls).toBe(0);
  });
  it("refreshes at a minute left, keeps the old refresh token when none is returned, and saves the new one", async () => {
    const t = tokens();
    t.save("spotify", saved({ expiresAt: 1_000_000 }));
    const got = await freshToken("spotify", t, async (rt) => ({ accessToken: `AT-for-${rt}`, expiresAt: 5_000_000 }), () => 1_000_000 - 59_000);
    expect(got).toBe("AT-for-RT1");
    expect(t.load("spotify")).toMatchObject({ accessToken: "AT-for-RT1", refreshToken: "RT1", expiresAt: 5_000_000, account: "me" });
  });
  it("shares one refresh between simultaneous calls", async () => {
    const t = tokens();
    t.save("spotify", saved({ expiresAt: 10 }));
    let calls = 0;
    const refresh = async () => { calls++; await new Promise((r) => setTimeout(r, 10)); return { accessToken: "AT2", expiresAt: 9_999_999 }; };
    const [a, b] = await Promise.all([freshToken("spotify", t, refresh, () => 100), freshToken("spotify", t, refresh, () => 100)]);
    expect([a, b]).toEqual(["AT2", "AT2"]);
    expect(calls).toBe(1);
  });
  it("returns null and does not try again when the refresh fails, and keeps the login for the owner to see", async () => {
    const t = tokens();
    t.save("spotify", saved({ expiresAt: 10 }));
    let calls = 0;
    const refresh = async () => { calls++; throw new RefreshRejected("invalid_grant AT1 RT1"); };
    expect(await freshToken("spotify", t, refresh, () => 100)).toBeNull();
    expect(await freshToken("spotify", t, refresh, () => 101)).toBeNull();
    expect(calls).toBe(1);
    expect(t.load("spotify")).not.toBeNull();
    expect(t.needsReconnect("spotify")).toBe(true);
  });
  it("is null when nobody has connected", async () => {
    expect(await freshToken("spotify", tokens(), async () => ({ accessToken: "x", expiresAt: 1 }), () => 0)).toBeNull();
  });
});

describe("renewing a login: what is permanent and what is not", () => {
  it("a refused renewal (the service says the login is no longer good) asks for a reconnect", async () => {
    const t = tokens();
    t.save("spotify", saved({ expiresAt: 10 }));
    expect(await freshToken("spotify", t, async () => { throw new RefreshRejected("no"); }, () => 100)).toBeNull();
    expect(t.needsReconnect("spotify")).toBe(true);
  });

  it("a network blip or a busy service does not end the login: it waits 30 seconds, then tries once more", async () => {
    const t = tokens();
    t.save("spotify", saved({ expiresAt: 10 }));
    let calls = 0;
    let fail = true;
    const refresh = async () => {
      calls++;
      if (fail) throw new Error("fetch failed");
      return { accessToken: "AT2", expiresAt: 9_999_999 };
    };
    expect(await freshToken("spotify", t, refresh, () => 100)).toBeNull();
    expect(t.needsReconnect("spotify")).toBe(false);
    expect(await freshToken("spotify", t, refresh, () => 20_000)).toBeNull();
    expect(calls).toBe(1);
    fail = false;
    expect(await freshToken("spotify", t, refresh, () => 40_000)).toBe("AT2");
    expect(calls).toBe(2);
  });

  it("a login forgotten while it is being renewed stays forgotten", async () => {
    const t = tokens();
    t.save("spotify", saved({ expiresAt: 10 }));
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const pending = freshToken("spotify", t, async () => { await gate; return { accessToken: "AT2", expiresAt: 9_999_999 }; }, () => 100);
    t.forget("spotify");
    release();
    expect(await pending).toBeNull();
    expect(t.load("spotify")).toBeNull();
  });
});
