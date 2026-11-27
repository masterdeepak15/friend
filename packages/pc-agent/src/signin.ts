import { createHash, randomBytes } from "node:crypto";
import type { AgentStore, Sealer } from "./store";

export interface Tokens {
  access: string;
  refresh: string;
  pcId: number;
  expiresIn: number;
}

export interface SignInDeps {
  server: string;
  enrollmentId: string;
  os: string;
  host: string;
  fetch?: typeof fetch;
  /** Opens the approval page in the person's browser, and says it in words too. */
  show(url: string, userCode: string): void;
  sleep?(ms: number): Promise<void>;
  /** Gives up after this long (the code lasts 10 minutes). */
  maxWaitMs?: number;
}

const json = { "content-type": "application/json" };

/**
 * The first sign-in (device authorization with PKCE): the agent keeps a secret, sends only its hash with the one-time enrollment id,
 * shows the owner a short code, and then proves it is the same program by sending the secret. Nobody who only saw the code can take
 * its place.
 */
export async function signIn(d: SignInDeps): Promise<Tokens> {
  const f = d.fetch ?? fetch;
  const sleep = d.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const base = d.server.replace(/\/+$/, "");

  const started = await f(`${base}/api/pc/enroll/start`, { method: "POST", headers: json, body: JSON.stringify({ enrollmentId: d.enrollmentId, challenge, os: d.os, host: d.host }) });
  const s = (await started.json().catch(() => ({}))) as { deviceCode?: string; userCode?: string; verifyPath?: string; interval?: number; expiresIn?: number; error?: string };
  if (!started.ok || !s.deviceCode || !s.userCode) throw new Error(s.error ?? "Friend did not accept this install link. Add the PC again in Plugins, Windows PCs.");
  d.show(`${base}${s.verifyPath ?? `/pc/approve?code=${s.userCode}`}`, s.userCode);

  const deadline = Date.now() + (d.maxWaitMs ?? (s.expiresIn ?? 600) * 1000);
  for (;;) {
    await sleep(Math.max(1, s.interval ?? 3) * 1000);
    if (Date.now() > deadline) throw new Error("The code was not approved in time. Run the install command again.");
    const r = await f(`${base}/api/pc/enroll/token`, { method: "POST", headers: json, body: JSON.stringify({ deviceCode: s.deviceCode, verifier }) });
    const body = (await r.json().catch(() => ({}))) as Partial<Tokens> & { error?: string; pending?: boolean };
    if (r.status === 202 || body.pending) continue;
    if (r.ok && body.access && body.refresh && typeof body.pcId === "number") return { access: body.access, refresh: body.refresh, pcId: body.pcId, expiresIn: body.expiresIn ?? 3600 };
    throw new Error(body.error === "expired" ? "The code expired before it was approved. Run the install command again." : "Friend refused this PC.");
  }
}

/** Keeps the PC signed in: the tokens are stored sealed, the access token is renewed shortly before it runs out. */
export class Session {
  private access_: string | null = null;
  private expiresAt = 0;

  constructor(
    private readonly store: AgentStore,
    private readonly sealer: Sealer,
    private readonly server: string,
    private readonly now: () => number = Date.now,
    private readonly f: typeof fetch = fetch,
  ) {}

  async save(t: Tokens): Promise<void> {
    this.access_ = t.access;
    this.expiresAt = this.now() + t.expiresIn * 1000;
    await this.store.setSecret(this.sealer, "refresh", t.refresh);
    this.store.set("pcId", String(t.pcId));
  }

  /** Whether this PC ever signed in. */
  async signedIn(): Promise<boolean> {
    return (await this.store.getSecret(this.sealer, "refresh")) !== null;
  }

  /** An access token that is good for at least two more minutes; "offline" when Friend cannot be reached; null when there is no sign-in or it was refused. */
  async access(): Promise<string | null | "offline"> {
    if (this.access_ && this.now() < this.expiresAt - 120_000) return this.access_;
    const r = await this.refresh();
    return r === "ok" ? this.access_ : r === "offline" ? "offline" : null;
  }

  /** Trades the refresh token for a new pair. "refused" when Friend refuses it (revoked, or the token was copied); "offline" when it cannot be reached. */
  async refresh(): Promise<"ok" | "refused" | "offline"> {
    const refresh = await this.store.getSecret(this.sealer, "refresh");
    if (!refresh) return "refused";
    let r: Response;
    try {
      r = await this.f(`${this.server.replace(/\/+$/, "")}/api/pc/token/refresh`, { method: "POST", headers: json, body: JSON.stringify({ refresh }) });
    } catch {
      return "offline"; // no network: try again later, the sign-in is still good
    }
    if (r.status === 401 || r.status === 400) {
      this.store.delete("secret:refresh"); // refused: there is nothing left to try
      return "refused";
    }
    if (!r.ok) return "offline"; // Friend is down or restarting
    const t = (await r.json()) as Tokens;
    await this.save(t);
    return "ok";
  }

  async clear(): Promise<void> {
    this.access_ = null;
    this.store.delete("secret:refresh");
  }
}
