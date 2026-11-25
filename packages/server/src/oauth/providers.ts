export interface ServiceProvider {
  id: string;
  name: string;
  authUrl: string;
  tokenUrl: string;
  revokeUrl?: string;
  scopes: string[];
  /** Extra parameters on the consent address (for example the offline access Google needs for a refresh token). */
  extraAuthParams?: Record<string, string>;
}

/** The services Friend knows how to sign in to without an MCP server. A client ID for each is registered once by whoever hosts Friend. */
export const PROVIDERS: readonly ServiceProvider[] = [
  {
    id: "google",
    name: "Google (Gmail)",
    authUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    revokeUrl: "https://oauth2.googleapis.com/revoke",
    scopes: ["openid", "email", "https://www.googleapis.com/auth/gmail.readonly"],
    extraAuthParams: { access_type: "offline", prompt: "consent", include_granted_scopes: "true" },
  },
];

export const providerById = (id: string): ServiceProvider | undefined => PROVIDERS.find((p) => p.id === id);
