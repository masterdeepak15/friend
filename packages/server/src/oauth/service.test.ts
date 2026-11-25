import { describe, expect, it } from "vitest";
import { RefreshRejected } from "../music/oauth";
import { PROVIDERS } from "./providers";
import { buildAuthUrl, exchangeCode, refresh, revoke } from "./service";

const google = PROVIDERS.find((p) => p.id === "google")!;
const reply = (status: number, body: unknown): typeof fetch => (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe("buildAuthUrl", () => {
  it("asks for a code with PKCE S256, the exact return address and a state", () => {
    const u = new URL(buildAuthUrl(google, { clientId: "cid", redirectUri: "https://h.example/api/oauth/callback", state: "st", challenge: "ch" }));
    expect(u.origin + u.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("code_challenge")).toBe("ch");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("redirect_uri")).toBe("https://h.example/api/oauth/callback");
    expect(u.searchParams.get("state")).toBe("st");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("client_secret")).toBeNull();
  });
});

describe("exchangeCode", () => {
  it("posts the code and verifier in the body, never in the address, and reads the account label", async () => {
    let seen: { url: string; body: string } | null = null;
    const idToken = `x.${Buffer.from(JSON.stringify({ email: "me@example.com" })).toString("base64url")}.y`;
    const f = (async (url: string, init: RequestInit) => {
      seen = { url, body: String(init.body) };
      return new Response(JSON.stringify({ access_token: "AT", refresh_token: "RT", expires_in: 100, scope: "openid email", id_token: idToken }), { status: 200 });
    }) as unknown as typeof fetch;
    const g = await exchangeCode(google, { clientId: "cid", clientSecret: "sec", code: "CODE", verifier: "VER", redirectUri: "https://h/cb" }, f, () => 1000);
    expect(g).toMatchObject({ accessToken: "AT", refreshToken: "RT", expiresAt: 101_000, account: "me@example.com", scopes: ["openid", "email"] });
    expect(seen!.url).toBe("https://oauth2.googleapis.com/token");
    expect(seen!.url).not.toContain("CODE");
    expect(seen!.body).toContain("code_verifier=VER");
    expect(seen!.body).toContain("redirect_uri=https%3A%2F%2Fh%2Fcb");
  });

  it("explains a refusal without echoing anything secret", async () => {
    await expect(exchangeCode(google, { clientId: "cid", code: "CODE", verifier: "V", redirectUri: "r" }, reply(400, { error: "invalid_grant", error_description: "CODE was used" }))).rejects.toThrow(/did not accept the sign-in \(invalid_grant\)/);
  });
});

describe("refresh", () => {
  it("gives a new access token", async () => {
    const r = await refresh(google, { clientId: "c", refreshToken: "RT" }, reply(200, { access_token: "AT2", expires_in: 60 }), () => 0);
    expect(r).toEqual({ accessToken: "AT2", refreshToken: undefined, expiresAt: 60_000 });
  });
  it("tells a dead login from a hiccup", async () => {
    await expect(refresh(google, { clientId: "c", refreshToken: "RT" }, reply(400, { error: "invalid_grant" }))).rejects.toBeInstanceOf(RefreshRejected);
    const hiccup = refresh(google, { clientId: "c", refreshToken: "RT" }, reply(500, {}));
    await expect(hiccup).rejects.toThrow(/could not renew/);
    await expect(hiccup).rejects.not.toBeInstanceOf(RefreshRejected);
  });
});

describe("revoke", () => {
  it("does not fail when the service cannot be reached", async () => {
    await expect(revoke(google, "AT", (async () => { throw new Error("offline"); }) as unknown as typeof fetch)).resolves.toBeUndefined();
  });
});
