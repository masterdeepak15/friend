# OAuth Connect Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (inline). Steps use checkbox syntax.

**Goal:** Connect MCP connectors and known services (Google first) with an approval link instead of pasted keys.

**Architecture:** One `OAuthHub` owns tickets/states, an encrypted vault and the callback. MCP connectors hand the MCP SDK a vault-backed `OAuthClientProvider` (`authProvider` on `StreamableHTTPClientTransport`); known services use a small PKCE flow with an injectable `fetch`. Every address derives from `config.publicUrl`.

**Tech Stack:** TypeScript ESM, Fastify, zod, vitest, `@modelcontextprotocol/sdk` 1.32.1, `secretBox.sealText/unsealText`.

**Spec:** `docs/superpowers/specs/2026-11-25-oauth-connect-design.md`

## Global Constraints

- HTTPS only for discovered/provider URLs; `http://` only for loopback.
- PKCE S256; `state` single-use, 10 minutes, at most 20 waiting.
- Tokens only in the vault (sealed, owner-only file); never in logs, audit rows, screens, model context, URLs.
- Redirect URI = `<publicUrl>/api/oauth/callback`, else `http://127.0.0.1:<port>/api/oauth/callback`; never hardcoded to a host.
- Existing header/key connectors unchanged. No publish/merge/push without the owner's word.
- Run: `npx vitest run <file>` in `packages/server` (or `packages/web`); `pnpm -r --no-sort typecheck`.

## Review Focus

- Callback with a replayed, expired, unknown or other-connector `state` → refused, nothing saved (Task 3, 7).
- Approval link opened twice / after 10 minutes → refused (Task 3, 7).
- Discovered URL pointing at a private/link-local/loopback address on a public connector → refused (Task 1).
- Provider refuses the refresh token → "Reconnect needed", one notice, no retry storm (Task 6).
- No token or `code` appears in audit rows or error text (Task 7).

---

### Task 1: SSRF guard
**Files:** Create `packages/server/src/oauth/guard.ts`, test `oauth/guard.test.ts`
**Produces:** `assertSafeUrl(raw: string, opts?: { allowLoopback?: boolean }): URL` (throws `Error`).
- [ ] Test: accepts `https://accounts.google.com/o/oauth2/v2/auth`; rejects `http://example.com`, `file:///x`, `javascript:x`, `https://127.0.0.1/x`, `https://10.0.0.5/`, `https://192.168.1.2/`, `https://169.254.169.254/`, `https://[::1]/`, `https://[fe80::1]/`, `https://[::ffff:10.0.0.1]/`, `https://localhost/`; with `allowLoopback` accepts `http://127.0.0.1:8080/` and `http://localhost/`.
- [ ] Run → fail; implement by parsing hostname (IPv4 dotted/decimal/hex via `net.isIP` after `new URL` normalisation, IPv6 prefix checks); run → pass; commit.

### Task 2: Vault
**Files:** Create `oauth/vault.ts`, test `oauth/vault.test.ts`
**Produces:**
```ts
export interface VaultEntry { tokens?: unknown; clientInfo?: unknown; issuer?: string; account?: string; scopes?: string[]; discovery?: unknown; verifier?: string; needsReconnect?: boolean }
export class OAuthVault { constructor(dataDir: string); get(key: string): VaultEntry; patch(key: string, p: Partial<VaultEntry>): void; forget(key: string): void; has(key: string): boolean; keys(): string[] }
```
Keys: `mcp:<connectorId>`, `svc:<providerId>`. File `oauth-vault.json` in dataDir, content sealed with `sealText(JSON.stringify(all), dataDir)`, mode 0600.
- [ ] Tests: round-trips; file on disk contains none of the token text; `forget` removes; damaged file → empty, not a throw; keys with different issuer are kept apart (`patch` with a new `issuer` clears `tokens`).
- [ ] Implement, pass, commit.

### Task 3: Tickets and states
**Files:** Create `oauth/tickets.ts`, test `oauth/tickets.test.ts`
**Produces:**
```ts
export class OAuthTickets { constructor(clock?: () => number);
  issueTicket(key: string): string;                 // random, single use, 10 min
  takeTicket(t: string): string | null;             // → key
  issueState(key: string, extra?: Record<string,string>): string;
  takeState(s: string): { key: string; extra: Record<string,string> } | null }
```
- [ ] Tests: single use; expiry at 10 min (injected clock); unknown/non-string → null; more than 20 waiting drops the oldest; a state is not accepted as a ticket and vice versa.
- [ ] Implement (adapt `music/oauth.ts` `OAuthStates`), pass, commit.

### Task 4: Redirect URI and settings slot
**Files:** Modify `config.ts` (add `oauth: { clients: Record<string, { clientId: string }> }`, `sanitizeOauth`, default `{ clients: {} }`, load in the same place as `eye`); Create `oauth/redirect.ts`; tests `oauth/redirect.test.ts`, extend config test.
**Produces:** `redirectUri(publicUrl: string | null, port: number): string`.
- [ ] Tests: `https://maya.example.com/` → `https://maya.example.com/api/oauth/callback`; null, 8787 → `http://127.0.0.1:8787/api/oauth/callback`; a different host gives a different URI (nothing hardcoded); sanitize drops non-string/over-long client ids and unknown provider keys with bad names.
- [ ] Implement, pass, commit. (Client **secret** is stored in the vault under `svc:<id>` via `OAuthHub.setClientSecret`, never in config.)

### Task 5: Known-service flow (Google)
**Files:** Create `oauth/providers.ts`, `oauth/service.ts`, test `oauth/service.test.ts`
**Produces:**
```ts
export interface ServiceProvider { id: string; name: string; authUrl: string; tokenUrl: string; revokeUrl?: string; scopes: string[]; extraAuthParams?: Record<string,string> }
export const PROVIDERS: ServiceProvider[]   // google: gmail.readonly + openid email; access_type=offline, prompt=consent
export function buildAuthUrl(p: ServiceProvider, a: { clientId: string; redirectUri: string; state: string; challenge: string }): string
export function exchangeCode(p, a: { clientId: string; clientSecret?: string; code: string; verifier: string; redirectUri: string }, f?: typeof fetch): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number; scopes: string[]; account?: string }>
export function refresh(p, a: { clientId; clientSecret?; refreshToken }, f?: typeof fetch, clock?): Promise<{ accessToken: string; refreshToken?: string; expiresAt: number }>   // throws RefreshRejected on invalid_grant
export function revoke(p, token: string, f?): Promise<void>
```
Reuse `pkcePair`, `RefreshRejected` from `music/oauth.ts`.
- [ ] Tests with a fake `fetch`: URL has `response_type=code`, `code_challenge_method=S256`, exact `redirect_uri`, `state`; exchange posts the verifier and redirect and never puts secrets in the URL; `invalid_grant` → `RefreshRejected`; 500 → plain Error (not Rejected); revoke tolerates failure.
- [ ] Implement, pass, commit.

### Task 6: OAuthHub
**Files:** Create `oauth/hub.ts`, test `oauth/hub.test.ts`
**Consumes:** Tasks 1–5.
**Produces:**
```ts
export interface OAuthHubDeps { dataDir: string; config: () => { publicUrl: string | null; port: number; oauth: { clients: Record<string,{clientId:string}> } };
  audit: { log(who: string, kind: string, d: object): void }; send: (text: string) => Promise<boolean>; fetch?: typeof fetch; clock?: () => number }
export class OAuthHub {
  redirectUri(): string;
  services(): { id; name; configured: boolean; connected: boolean; needsReconnect: boolean; account: string | null; redirectUri: string }[];
  startService(id: string, opts?: { toPhone?: boolean }): Promise<{ link: string; sent: boolean }>;   // throws if client slot empty: "Add the Google client ID first"
  openTicket(ticket: string): string | null;                      // → provider consent URL (single use)
  callback(params: Record<string,string>): Promise<{ ok: boolean; key?: string }>;
  accessToken(id: string): Promise<string | null>;               // refreshes ahead of expiry, shares one refresh
  disconnect(key: string): Promise<void>;                        // revoke then forget
  setClientSecret(id: string, secret: string): void;             // vault only, write-only
  vault: OAuthVault; tickets: OAuthTickets;
}
```
Audit kinds: `oauth.start`, `oauth.connected`, `oauth.refresh.failed`, `oauth.revoked` with `{ key, account? }` only.
- [ ] Tests (fake provider endpoints via `fetch`): full round trip start → openTicket → callback → `services()` shows connected and account; accessToken returns saved token, refreshes when <60 s left, concurrent callers share one refresh; refresh rejected → `needsReconnect` true, `send` called once, `accessToken` null until reconnect; callback with replayed/expired/unknown state → `{ok:false}` and vault untouched; ticket second use → null; `startService("google")` with empty client slot throws a plain message; `toPhone` calls `send` with the link; JSON of every audit row and every thrown message contains no token, code, or secret; `disconnect` calls revoke then removes the entry.
- [ ] Implement, pass, commit.

### Task 7: MCP connectors use the library
**Files:** Create `oauth/mcpProvider.ts`, test `oauth/mcpProvider.test.ts`; Modify `connectors/store.ts` (Http schema: optional `auth: z.literal("oauth").optional()`; `hasSecrets` unchanged), `connectors/hub.ts` (`HubOptions.oauth?: { providerFor(id: string): OAuthClientProvider }`; `transportFor` passes `authProvider` when `cfg.auth === "oauth"`; connect catches `UnauthorizedError` → status `"needs-approval"` with `error: "Waiting for your approval"`; new `McpHub.finishOAuth(id: string, code: string): Promise<ConnectorView>` calls the live transport's `finishAuth(code)` then reconnects), tests in `connectors/hub.test.ts`.
**Produces:** `class VaultOAuthProvider implements OAuthClientProvider` constructed `(key: string, vault: OAuthVault, redirectUrl: string, onApproval: (url: URL) => void, clientName: string)`; `clientMetadata` = `{ client_name, redirect_uris: [redirectUrl], grant_types: ["authorization_code","refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }`; `redirectToAuthorization(u)` runs `assertSafeUrl(u)` then `onApproval(u)`; `state()` from `OAuthTickets.issueState(key)`; tokens/clientInfo/verifier/discovery stored through the vault; `invalidateCredentials` maps scopes to vault fields.
- [ ] Tests: provider saves and loads tokens/verifier through the vault, nothing plain on disk; `redirectToAuthorization` with a private-address URL throws; against a fake MCP server that answers 401 with `WWW-Authenticate: Bearer resource_metadata=…` + fake AS metadata, `hub.add({kind:"http", auth:"oauth", …})` ends `needs-approval` (not `error`), and after `finishOAuth(id, code)` it is `ready` and the next MCP request carries `Authorization: Bearer <token>` in the header only; a non-oauth connector behaves as before (existing hub tests stay green).
- [ ] Implement, pass, commit.

### Task 8: Routes, wiring and approval link to the phone
**Files:** Modify `gateway.ts` (routes below), `app.ts` (create `OAuthHub`, `VaultOAuthProvider` factory for `McpHub`, `send` via `channelHub`), new `OAuthApi` interface; test `oauth/routes.test.ts`.
Routes:
- `GET /api/oauth/start/:ticket` (no cookie; ticket is the proof; rate-limit like music return) → 302 to consent URL, else 404; headers `cache-control: no-store`, `referrer-policy: no-referrer`.
- `GET /api/oauth/callback` (state is the proof) → `OAuthHub.callback` or for `mcp:` keys `McpHub.finishOAuth`; replies a small "Connected, you can close this" / "That did not work" page; same params-sanitising as the music callback.
- Owner routes behind `connectorGuard` style session check: `GET /api/oauth/services`, `POST /api/oauth/services/:id/connect {toPhone?}`, `POST /api/oauth/services/:id/disconnect`, `POST /api/oauth/connectors/:id/connect {toPhone?}`, `PUT /api/oauth/services/:id/client {clientId, clientSecret?, pin}` (PIN required; saves id to settings, secret to vault).
- [ ] Tests (app-level, fake AS): signed-out owner routes 401; start→callback round trip marks the service connected; replayed ticket 404; callback with bad state shows failure and saves nothing; `connect {toPhone:true}` sends one message containing the link and no token; client PUT without PIN → 400/403; audit rows contain no secrets.
- [ ] Implement, pass, full server suite + typecheck, commit.

### Task 9: Connect card (web)
**Files:** Modify `web/src/connectors/ConnectorsPanel.tsx`, create `web/src/connectors/oauthApi.ts`, test `web/src/connectors/oauth.test.tsx`.
- [ ] Tests: lists services with state text ("Not set up", "Ready to connect", "Connected as x", "Reconnect needed"); empty slot shows the exact redirect URI and a client-ID field; Connect opens the link (new window, `noopener`); "Send the link to my phone" calls the API with `toPhone`; Disconnect asks once; an HTTP connector with `auth:"oauth"` shows "Waiting for your approval" with the same two buttons.
- [ ] Implement, pass web suite + typecheck, commit.

### Task 10: Assistant can ask, never approve
**Files:** Modify `protocol/src/tools.ts` (tool `connect.start {service?: string; connector?: string}`, tier T0, owner turns only), `server/src/agent/loop.ts` handler, `agent/activity.ts` label; tests `agent/connect.test.ts`.
- [ ] Tests: owner turn gets the approval link text (sent to the phone when a channel exists) and no token; guest/member/office/task turns refused; result string contains no token; unknown service names the available ones.
- [ ] Implement, pass, commit.

### Final
- [ ] Full suites (`server`, `web`, `protocol`) and `pnpm -r --no-sort typecheck`; read every failure.
- [ ] Final self-review of the branch against the spec; ledger deferred items. Do **not** merge, publish or push: leave on `feat/oauth-connect` for the owner.
