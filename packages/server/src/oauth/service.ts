import { RefreshRejected } from "../music/oauth";
import { assertSafeUrl } from "./guard";
import type { ServiceProvider } from "./providers";

export interface Granted {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
  scopes: string[];
  account?: string;
}

type Fetch = typeof fetch;

export function buildAuthUrl(p: ServiceProvider, a: { clientId: string; redirectUri: string; state: string; challenge: string }): string {
  const u = assertSafeUrl(p.authUrl);
  u.searchParams.set("response_type", "code");
  u.searchParams.set("client_id", a.clientId);
  u.searchParams.set("redirect_uri", a.redirectUri);
  u.searchParams.set("scope", p.scopes.join(" "));
  u.searchParams.set("state", a.state);
  u.searchParams.set("code_challenge", a.challenge);
  u.searchParams.set("code_challenge_method", "S256");
  for (const [k, v] of Object.entries(p.extraAuthParams ?? {})) u.searchParams.set(k, v);
  return u.toString();
}

async function postForm(url: string, body: URLSearchParams, f: Fetch): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await f(assertSafeUrl(url).toString(), {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body,
    redirect: "error",
    signal: AbortSignal.timeout(20_000),
  });
  let json: Record<string, unknown> = {};
  try {
    json = (await res.json()) as Record<string, unknown>;
  } catch {
    /* an empty or non-JSON answer */
  }
  return { status: res.status, json };
}

/** The email in an ID token, only as a label for the screen. It is never trusted for anything. */
function labelOf(idToken: unknown): string | undefined {
  if (typeof idToken !== "string") return undefined;
  try {
    const payload = JSON.parse(Buffer.from(idToken.split(".")[1] ?? "", "base64url").toString("utf8")) as { email?: unknown };
    return typeof payload.email === "string" ? payload.email.slice(0, 120) : undefined;
  } catch {
    return undefined;
  }
}

const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) ? v : d);

export async function exchangeCode(
  p: ServiceProvider,
  a: { clientId: string; clientSecret?: string; code: string; verifier: string; redirectUri: string },
  f: Fetch = fetch,
  clock: () => number = Date.now,
): Promise<Granted> {
  const body = new URLSearchParams({ grant_type: "authorization_code", code: a.code, code_verifier: a.verifier, redirect_uri: a.redirectUri, client_id: a.clientId });
  if (a.clientSecret) body.set("client_secret", a.clientSecret);
  const { status, json } = await postForm(p.tokenUrl, body, f);
  if (status < 200 || status >= 300 || typeof json.access_token !== "string") throw new Error(`${p.name} did not accept the sign-in (${typeof json.error === "string" ? json.error.slice(0, 60) : status}).`);
  return {
    accessToken: json.access_token,
    refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined,
    expiresAt: clock() + num(json.expires_in, 3600) * 1000,
    scopes: typeof json.scope === "string" ? json.scope.split(" ").filter(Boolean) : p.scopes,
    account: labelOf(json.id_token),
  };
}

/** A new access token. A refusal that means the login is no longer good is RefreshRejected; anything else is a plain error to try again later. */
export async function refresh(
  p: ServiceProvider,
  a: { clientId: string; clientSecret?: string; refreshToken: string },
  f: Fetch = fetch,
  clock: () => number = Date.now,
): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number }> {
  const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: a.refreshToken, client_id: a.clientId });
  if (a.clientSecret) body.set("client_secret", a.clientSecret);
  const { status, json } = await postForm(p.tokenUrl, body, f);
  if (json.error === "invalid_grant" || json.error === "invalid_client" || json.error === "unauthorized_client") throw new RefreshRejected(String(json.error));
  if (status < 200 || status >= 300 || typeof json.access_token !== "string") throw new Error(`${p.name} could not renew the sign-in (${status}).`);
  return { accessToken: json.access_token, refreshToken: typeof json.refresh_token === "string" ? json.refresh_token : undefined, expiresAt: clock() + num(json.expires_in, 3600) * 1000 };
}

/** Tells the service to forget this login. Best effort: failing to reach it does not stop Friend forgetting it. */
export async function revoke(p: ServiceProvider, token: string, f: Fetch = fetch): Promise<void> {
  if (!p.revokeUrl) return;
  try {
    await postForm(p.revokeUrl, new URLSearchParams({ token }), f);
  } catch {
    /* the owner can also remove Friend in the service's own account settings */
  }
}
