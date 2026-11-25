import { pkcePair, RefreshRejected } from "../music/oauth";
import { providerById, PROVIDERS, type ServiceProvider } from "./providers";
import { redirectUri } from "./redirect";
import { buildAuthUrl, exchangeCode, refresh, revoke } from "./service";
import { OAuthTickets } from "./tickets";
import { OAuthVault } from "./vault";

const REFRESH_AHEAD_MS = 60_000;
const TRANSIENT_WAIT_MS = 30_000;

export interface OAuthHubDeps {
  dataDir: string;
  config: () => { publicUrl: string | null; port: number; oauth: { clients: Record<string, { clientId: string }> } };
  audit: { log(who: string, kind: string, details: object): void };
  /** Sends a message to the owner's phone. False when there is no way to. */
  send: (text: string) => Promise<boolean>;
  fetch?: typeof fetch;
  clock?: () => number;
}

export interface ServiceView {
  id: string;
  name: string;
  /** The host has registered a client ID for it. */
  configured: boolean;
  connected: boolean;
  needsReconnect: boolean;
  account: string | null;
  /** The exact return address to register with the service. */
  redirectUri: string;
}

interface Saved {
  accessToken: string;
  refreshToken?: string;
  expiresAt: number;
}

/**
 * Everything about signing in to outside services with a link: the vault, the approval links, the return from the service and keeping logins fresh.
 * A token is only ever handed to the code that calls the service; no screen, log, audit row or message carries one.
 */
export class OAuthHub {
  readonly vault: OAuthVault;
  readonly tickets: OAuthTickets;
  private clock: () => number;
  private f: typeof fetch;
  private refreshing = new Map<string, Promise<string | null>>();
  private waitUntil = new Map<string, number>();
  /** The consent address an MCP connector's login library asked us to send the owner to, until the owner opens its link. */
  private mcpPending = new Map<string, string>();

  constructor(private d: OAuthHubDeps) {
    this.clock = d.clock ?? Date.now;
    this.f = d.fetch ?? fetch;
    this.vault = new OAuthVault(d.dataDir);
    this.tickets = new OAuthTickets(this.clock);
  }

  private base(): string {
    const c = this.d.config();
    return (c.publicUrl ?? `http://127.0.0.1:${c.port}`).replace(/\/+$/, "");
  }

  redirectUri(): string {
    const c = this.d.config();
    return redirectUri(c.publicUrl, c.port);
  }

  services(): ServiceView[] {
    const clients = this.d.config().oauth.clients;
    return PROVIDERS.map((p) => {
      const e = this.vault.get(`svc:${p.id}`);
      return { id: p.id, name: p.name, configured: !!clients[p.id], connected: !!e.tokens, needsReconnect: !!e.needsReconnect, account: e.account ?? null, redirectUri: this.redirectUri() };
    });
  }

  private clientOf(p: ServiceProvider): { clientId: string; clientSecret?: string } {
    const c = this.d.config().oauth.clients[p.id];
    if (!c) throw new Error(`Add the ${p.name} client ID first (Settings, Connectors).`);
    return { clientId: c.clientId, clientSecret: this.vault.get(`svc:${p.id}`).clientSecret };
  }

  private async deliver(key: string, toPhone: boolean | undefined, label: string): Promise<{ link: string; sent: boolean }> {
    const link = `${this.base()}/api/oauth/start/${this.tickets.issueTicket(key)}`;
    this.d.audit.log("owner", "oauth.start", { key });
    const sent = toPhone ? await this.d.send(`Approve the ${label} connection (the link works once, for ten minutes):\n${link}`).catch(() => false) : false;
    return { link, sent };
  }

  /** An approval link for a known service. Nothing happens until the owner opens it. */
  async startService(id: string, opts: { toPhone?: boolean } = {}): Promise<{ link: string; sent: boolean }> {
    const p = providerById(id);
    if (!p) throw new Error("Friend does not know that service.");
    this.clientOf(p);
    return this.deliver(`svc:${id}`, opts.toPhone, p.name);
  }

  /** An approval link for an MCP connector whose login the library has begun: the library gave the consent address. */
  async approvalForMcp(connectorId: string, consent: URL, label: string, toPhone?: boolean): Promise<{ link: string; sent: boolean }> {
    const key = `mcp:${connectorId}`;
    this.mcpPending.set(key, consent.toString());
    return this.deliver(key, toPhone, label);
  }

  /** The consent address behind a link, once. Null for a link that is unknown, used or older than ten minutes. */
  openTicket(ticket: string): string | null {
    const key = this.tickets.takeTicket(ticket);
    if (!key) return null;
    if (key.startsWith("mcp:")) {
      const url = this.mcpPending.get(key) ?? null;
      this.mcpPending.delete(key);
      return url;
    }
    const p = providerById(key.slice(4));
    if (!p) return null;
    try {
      const { clientId } = this.clientOf(p);
      const { verifier, challenge } = pkcePair();
      const state = this.tickets.issueState(key, { verifier });
      return buildAuthUrl(p, { clientId, redirectUri: this.redirectUri(), state, challenge });
    } catch {
      return null;
    }
  }

  /** The service sent the owner back. For a known service the login is finished here; for an MCP connector the code is handed back to finish it. */
  async callback(params: Record<string, string>): Promise<{ ok: boolean; key?: string; code?: string }> {
    const st = this.tickets.takeState(params.state ?? "");
    if (!st) return { ok: false };
    if (params.error || !params.code) {
      this.d.audit.log("owner", "oauth.refused", { key: st.key });
      return { ok: false, key: st.key };
    }
    if (st.key.startsWith("mcp:")) return { ok: true, key: st.key, code: params.code };
    const p = providerById(st.key.slice(4));
    if (!p) return { ok: false };
    try {
      if (params.iss && params.iss !== new URL(p.authUrl).origin) throw new Error("wrong issuer");
      const c = this.clientOf(p);
      const g = await exchangeCode(p, { ...c, code: params.code, verifier: st.extra.verifier ?? "", redirectUri: this.redirectUri() }, this.f, this.clock);
      const tokens: Saved = { accessToken: g.accessToken, refreshToken: g.refreshToken, expiresAt: g.expiresAt };
      this.vault.patch(st.key, { issuer: new URL(p.authUrl).origin, tokens, account: g.account, scopes: g.scopes, needsReconnect: false });
      this.waitUntil.delete(st.key);
      this.d.audit.log("owner", "oauth.connected", { key: st.key, account: g.account ?? null });
      return { ok: true, key: st.key };
    } catch {
      this.d.audit.log("owner", "oauth.failed", { key: st.key });
      return { ok: false, key: st.key };
    }
  }

  /** A good access token for a known service, renewed when it is about to end. Null when not connected or the login has to be redone. */
  async accessToken(id: string): Promise<string | null> {
    const key = `svc:${id}`;
    const p = providerById(id);
    const e = this.vault.get(key);
    const t = e.tokens as Saved | undefined;
    if (!p || !t || e.needsReconnect) return null;
    if (t.expiresAt - this.clock() > REFRESH_AHEAD_MS) return t.accessToken;
    if (!t.refreshToken) return null;
    if ((this.waitUntil.get(key) ?? 0) > this.clock()) return null;
    const running = this.refreshing.get(key);
    if (running) return running;
    const job = (async (): Promise<string | null> => {
      try {
        const next = await refresh(p, { ...this.clientOf(p), refreshToken: t.refreshToken! }, this.f, this.clock);
        this.vault.patch(key, { tokens: { accessToken: next.accessToken, refreshToken: next.refreshToken ?? t.refreshToken, expiresAt: next.expiresAt } satisfies Saved });
        return next.accessToken;
      } catch (err) {
        if (err instanceof RefreshRejected) {
          this.vault.patch(key, { needsReconnect: true });
          this.d.audit.log("system", "oauth.refresh.failed", { key });
          void this.d.send(`Your ${p.name} sign-in ended. Open Friend and press Connect to sign in again.`).catch(() => false);
        } else this.waitUntil.set(key, this.clock() + TRANSIENT_WAIT_MS);
        return null;
      } finally {
        this.refreshing.delete(key);
      }
    })();
    this.refreshing.set(key, job);
    return job;
  }

  /** Tells the service to forget the login, then forgets it here. A client secret the owner typed stays. */
  async disconnect(key: string): Promise<void> {
    const e = this.vault.get(key);
    if (key.startsWith("svc:")) {
      const p = providerById(key.slice(4));
      const t = e.tokens as Saved | undefined;
      if (p && t) await revoke(p, t.refreshToken ?? t.accessToken, this.f);
    }
    this.vault.forget(key);
    if (e.clientSecret) this.vault.patch(key, { clientSecret: e.clientSecret });
    this.mcpPending.delete(key);
    this.d.audit.log("owner", "oauth.revoked", { key });
  }

  /** Write-only: nothing gives the secret back. */
  setClientSecret(id: string, secret: string): void {
    this.vault.patch(`svc:${id}`, { clientSecret: secret });
  }
}
