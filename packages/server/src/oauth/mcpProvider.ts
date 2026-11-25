import type { OAuthClientProvider, OAuthDiscoveryState } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { assertSafeUrl } from "./guard";
import type { OAuthTickets } from "./tickets";
import type { OAuthVault } from "./vault";

/**
 * The login of one MCP connector, kept in the vault. The MCP library does the protocol (discovery, registration, PKCE, renewal);
 * this only says where things are kept and that the owner is sent a link instead of a browser being opened.
 */
export class VaultOAuthProvider implements OAuthClientProvider {
  constructor(
    private key: string,
    private vault: OAuthVault,
    private tickets: OAuthTickets,
    private redirect: string,
    private clientName: string,
    /** Gets the consent address the owner has to be sent to. */
    private onConsent: (url: URL) => void,
    /** The connector itself is on this PC, so its sign-in pages may be too. */
    private allowLoopback = false,
  ) {}

  get redirectUrl(): string {
    return this.redirect;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: this.clientName,
      redirect_uris: [this.redirect],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    };
  }

  state(): string {
    return this.tickets.issueState(this.key);
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.vault.get(this.key).clientInfo as OAuthClientInformationMixed | undefined;
  }

  saveClientInformation(info: OAuthClientInformationMixed): void {
    const issuer = (info as { issuer?: string }).issuer;
    this.vault.patch(this.key, { clientInfo: info, ...(issuer ? { issuer } : {}) });
  }

  tokens(): OAuthTokens | undefined {
    return this.vault.get(this.key).tokens as OAuthTokens | undefined;
  }

  saveTokens(tokens: OAuthTokens): void {
    const issuer = (tokens as { issuer?: string }).issuer;
    this.vault.patch(this.key, { tokens, needsReconnect: false, ...(issuer ? { issuer } : {}) });
  }

  redirectToAuthorization(url: URL): void {
    assertSafeUrl(url.toString(), { allowLoopback: this.allowLoopback });
    this.onConsent(url);
  }

  saveCodeVerifier(v: string): void {
    this.vault.patch(this.key, { verifier: v });
  }

  codeVerifier(): string {
    const v = this.vault.get(this.key).verifier;
    if (!v) throw new Error("There is no sign-in in progress.");
    return v;
  }

  saveDiscoveryState(s: OAuthDiscoveryState): void {
    this.vault.patch(this.key, { discovery: s });
  }

  discoveryState(): OAuthDiscoveryState | undefined {
    return this.vault.get(this.key).discovery as OAuthDiscoveryState | undefined;
  }

  invalidateCredentials(scope: "all" | "client" | "tokens" | "verifier" | "discovery"): void {
    const clear: Record<string, undefined> = {};
    if (scope === "all" || scope === "client") clear.clientInfo = undefined;
    if (scope === "all" || scope === "tokens") clear.tokens = undefined;
    if (scope === "all" || scope === "verifier") clear.verifier = undefined;
    if (scope === "all" || scope === "discovery") clear.discovery = undefined;
    this.vault.patch(this.key, clear);
  }
}
