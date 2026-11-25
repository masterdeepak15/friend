# Connect with a link: OAuth 2.1 for connectors and plugins

Status: awaiting owner approval. Size: a project.

## Why

Today every connector or plugin is set up by hand: a URL plus a pasted key (`connectors.json` headers, the Chrome form, the Zerodha form). The owner wants the opposite: press Connect, approve a link (on the screen or the phone), and Friend holds the login itself. Gmail is the first service that needs it. "No manual configuration" is the point.

## Goals

- One **Connect** flow for MCP connectors (HTTP) and for known services (Google first).
- Approval by link, also from a phone with no browser on the Friend PC (headless).
- Tokens kept encrypted, refreshed on their own, revoked on disconnect.
- Every address is derived from the host's own `publicUrl`. Nothing is tied to maya.chougale.com; another host works with no code change.

## Non-goals

- No Friend-run authorization server (Friend is only a client here).
- Existing key-and-header connectors keep working unchanged; no forced migration.
- Chrome plugin's pasted key is not replaced here (separate, later, as the device approval in the PC design).
- Not Google app verification (a business step for the owner).

## Anti-goals (failure even if it works)

- A token reaching the model, a log, a screen, a URL query, or another server.
- A link that connects the wrong account, or one that can be replayed.
- Setup that needs the owner to read an RFC.

## Approaches considered

- A. Only the MCP library's OAuth client. Least code; covers MCP servers only, not Google's own API.
- B. Hand-built flow like the Spotify login. Covers everything; duplicates the library.
- **C (chosen by owner). Both, sharing one vault, one callback route and one approval link.** MCP connectors use the library's `authProvider`; known services use a small provider list with a Spotify-style PKCE flow.

Redirect handling (owner has not picked; default taken, marked as my call):
1. **Each host registers their own client** and Friend shows the exact redirect URI. *(my call, default)*
2. Desktop-type client with loopback redirect (needs the browser on the Friend PC).
3. A fixed relay on the owner's domain (one client for all hosts; the owner runs it).
Design keeps the redirect behind one function so 2 and 3 can be added later.

## Design

**Redirect URI.** `redirectUri() = <config.publicUrl>/api/oauth/callback`; if no `publicUrl`, `http://127.0.0.1:<port>/api/oauth/callback` and the card says an approval from another device needs a public address. The Connect card shows the exact string to register.

**Vault** (`oauth/vault.ts`). Per connector id and per issuer: access token, refresh token, expiry, scopes, account label, client information. Stored with the existing `secretBox` `sealText` in the data folder, owner-only file. Tokens are keyed by issuer (never reused with another one). Write-only to the UI: it learns "connected as x", never a token.

**States.** Reuse the `OAuthStates` idea: single-use `state`, 10 minutes, bounded count, PKCE S256 verifier kept server side. Record the issuer before redirecting and check RFC 9207 `iss` on return when the server sends it.

**MCP path.** `McpHub.transportFor` passes an `OAuthClientProvider` backed by the vault to `StreamableHTTPClientTransport`. The library discovers the protected-resource and authorization-server metadata, registers dynamically when allowed, sends `resource`, and refreshes. When it needs the owner, `redirectToAuthorization` does not open a browser; it creates an **approval link** and the connector shows "Waiting for your approval".

**Known-service path.** `oauth/providers.ts`: a list of `{ id, authUrl, tokenUrl, revokeUrl, scopes, usesPkce }` (Google first) and a **client slot** per provider in settings (`oauth.clients.google = { clientId, clientSecret? }`), empty until the owner supplies it tomorrow. With the slot empty the card says what is missing and where to put it; nothing breaks.

**Approval link.** `GET /api/oauth/start/:ticket` (ticket = random, single use, 10 minutes). Opened on any device, it redirects to the service's consent page. It can be shown on the screen or sent to the owner's phone with the same send path as the Zerodha login link. The callback `GET /api/oauth/callback` takes the code, exchanges it, saves it, and shows a plain "Connected, you can close this".

**Who may start one.** Only the signed-in owner (screen) or the owner's own phone channel. The assistant can *ask* for a connection (tool `connect.start`), which only produces the link; it can never approve it, and never sees the token.

**Revoke and failure.** Disconnect calls the provider's revocation endpoint (RFC 7009) when it has one, then deletes the vault entry. A refresh the service refuses marks the connector "Reconnect needed" and sends one silent notice to the phone. A hiccup retries later (same rule as the music logins).

**Security rules carried from the reference.** HTTPS only (loopback for dev), SSRF guard on every discovered URL (no private, link-local or loopback addresses unless the connector itself is loopback), redirect hops validated, exact redirect-URI match, tokens only in `Authorization`, never in logs (redact `code`, `access_token`, `refresh_token`, `client_secret`), no token passthrough to other servers, minimum scopes.

**Audit.** `oauth.start`, `oauth.connected`, `oauth.refresh.failed`, `oauth.revoked` (provider, connector, account label; never a token).

**Screen.** In Settings → Connectors a card per service: status, Connect / Disconnect, "Send the link to my phone", and, when a client slot is empty, the one-line fix.

## Constraints

TypeScript ESM; MCP SDK 1.32.1; free services only; cross-platform; knobs are settings, safety floors fixed (HTTPS, PKCE, single-use state, no token to the model).

## Left to the builder

File layout, ticket and state storage details, exact settings keys, wording of the card, test seams (fake authorization server).

## Missing things already found

1. Google restricted scopes: unverified apps are capped at 100 users and, in Testing status, refresh tokens expire in 7 days (to be confirmed before relying on it). Fine for the owner's account; a client shared with many hosts would need Google verification.
2. A public address is needed for approval from a phone.
3. The owner's Google client ID (expected 2026-11-26); type (Web or Desktop) decides the redirect rules.
