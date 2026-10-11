# Music sources and Spotify (plan 1 of 3) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the owner connect their own Spotify account with OAuth and have the assistant and the screen player search and play Spotify music next to the local folder.

**Architecture:** A `MusicSource` interface and `MusicSources` registry sit beside `MusicLibrary` (which becomes the `local` source). Tracks are addressed by a `ref` (`local:<id>` or `spotify:<id>`; a bare 16-hex id still means local). A shared PKCE OAuth module stores tokens in the data folder like `BrokerSessions`. Spotify plays in the browser through Spotify's Web Playback SDK; the player picks an engine per track.

**Tech Stack:** TypeScript, Fastify, zod (`@friend/protocol`), React 18, vitest, Node `crypto`/`fetch`. No new npm dependencies (the Spotify SDK is loaded from `https://sdk.scdn.co/spotify-player.js` at run time, only after the owner connects Spotify).

**Spec:** `docs/superpowers/specs/2026-10-11-music-sources-design.md` (host output is plan 2, SoundCloud is plan 3; neither is in this plan).

## Global Constraints

- Sign-in is OAuth Authorization Code with PKCE (`S256`); no client secret; the owner never types a Spotify password into Friend.
- `state` is single use and expires after 10 minutes. Tokens are refreshed 60 seconds before expiry; a failed refresh marks the source "reconnect needed" and is not retried in a loop.
- Redirect URI is `<publicUrl>/api/music/oauth/callback`, or `http://127.0.0.1:<port>/api/music/oauth/callback` when there is no `publicUrl` (never `localhost`). It is derived, never hardcoded.
- Connect, disconnect and changing the client id need the owner's PIN and are refused for the assistant.
- Only `https://accounts.spotify.com` and `https://api.spotify.com` are called by the server. Service text (titles, artists) is untrusted data.
- New settings: `music.sources: { spotify: boolean }`, `music.defaultSource: "local" | "spotify" | "any"` (default `local`), `music.searchLimit` 3–50 (default 10). Defaults live in `config.ts`, not in call sites.
- Bare 16-hex ids keep working everywhere (`local:` is implied).
- No test calls a real service.

## Review Focus

- Tokens or the client id leaking into `GET /api/settings`, the `ui` message, logs or the assistant's context → test asserts none contain a token.
- A callback replayed, expired, or with a state Friend did not issue → refused, no token change.
- Spotify free account (can search, cannot play) → plain sentence, nothing plays silently.
- Spotify returns 429/5xx/garbage JSON → one plain sentence, no retry loop, local music unaffected.
- A queue saved before this change (bare ids) → still plays as local.

---

### Task 1: Track refs in the protocol

**Files:**
- Modify: `packages/protocol/src/messages.ts` (`MusicTrackRef`, ~line 43), `packages/protocol/src/tools.ts` (music tool defs)
- Create: `packages/protocol/src/musicRef.ts`; export it from `packages/protocol/src/index.ts`
- Test: `packages/protocol/src/musicRef.test.ts`

**Interfaces:**
- Produces: `type MusicSourceId = "local" | "spotify"`; `MUSIC_SOURCES: readonly MusicSourceId[]`; `parseRef(ref: string): { source: MusicSourceId; id: string } | null`; `makeRef(source: MusicSourceId, id: string): string`; `MusicTrackRef.id` now accepts a ref (bare 16-hex or `<source>:<id>` with `id` matching `^[A-Za-z0-9_-]{1,64}$`); every music tool that takes or returns tracks gains optional `source: "local" | "spotify" | "any"`.

- [ ] **Step 1: Write failing tests** in `musicRef.test.ts`: `parseRef("0123456789abcdef")` → `{source:"local", id:"0123456789abcdef"}`; `parseRef("spotify:4uLU6hMCjMI75M1A2tKUQC")` → spotify; `parseRef("spotify:../x")`, `parseRef("youtube:abc")`, `parseRef("")` → `null`; `makeRef("local","0123456789abcdef")` → `"local:0123456789abcdef"`; `MusicTrackRef.parse` accepts both forms and rejects `"spotify:"`.
- [ ] **Step 2:** Run `cd packages/protocol && npx vitest run src/musicRef.test.ts` — Expected: FAIL (module missing).
- [ ] **Step 3:** Implement `musicRef.ts` and relax the regex in `MusicTrackRef`; add `source` to the music tool defs and their `describeCall` text.
- [ ] **Step 4:** Run `npx vitest run` in `packages/protocol` — Expected: PASS, no other protocol test breaks.
- [ ] **Step 5:** Commit `feat(protocol): music track refs and the source argument`.

### Task 2: Config and settings for sources

**Files:**
- Modify: `packages/server/src/config.ts` (`MusicConfig`, `DEFAULT_MUSIC`, `sanitizeMusic`), `packages/server/src/settings.ts` (zod `music`, view, apply), `packages/web/src/settings/settingsApi.ts` (`MusicSettings`, `diffSettings` already diffs by key)
- Test: `packages/server/src/music/settings.test.ts` (extend)

**Interfaces:**
- Produces: `MusicConfig` gains `sources: { spotify: boolean }`, `defaultSource: "local" | "spotify" | "any"`, `searchLimit: number`, `spotify: { installed: boolean; enabled: boolean; clientId: string }`. `spotify.clientId` is shown in the settings view (it is not secret); tokens are never in config.

- [ ] **Step 1: Write failing tests**: sanitize clamps `searchLimit` to 3–50, defaults `defaultSource` to `local`, drops an unknown source, trims `clientId` to `^[A-Za-z0-9]{8,64}$` or `""`; saving via settings with a PIN applies live; the assistant (`refuseForAgent`) is refused for `music.sources`, `music.defaultSource`, `music.spotify`.
- [ ] **Step 2:** Run `cd packages/server && npx vitest run src/music/settings.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Implement the fields in `config.ts`, `settings.ts` (zod, view, apply) and the web `MusicSettings` type.
- [ ] **Step 4:** Run server `npx tsc --noEmit` and the same test — Expected: PASS.
- [ ] **Step 5:** Commit `feat(music): source settings`.

### Task 3: Source interface, registry and the local source

**Files:**
- Create: `packages/server/src/music/source.ts`
- Test: `packages/server/src/music/source.test.ts`

**Interfaces:**
- Consumes: `MusicLibrary.list`, `find`, `stats` (library.ts); `parseRef`, `makeRef` (Task 1).
- Produces:
  - `interface SourceTrack { ref: string; source: MusicSourceId; title: string; artist: string; album: string; durationSec: number | null }`
  - `interface SourceStatus { connected: boolean; needs: string | null; account: string | null }`
  - `interface MusicSource { id: MusicSourceId; status(): SourceStatus; search(query: string, limit: number): Promise<SourceTrack[]>; playlists(limit: number): Promise<{ id: string; name: string; tracks: number }[]>; tracksOf(playlistId: string, limit: number): Promise<SourceTrack[]>; track(id: string): Promise<SourceTrack | null> }`
  - `class LocalSource implements MusicSource` (wraps `MusicLibrary`, `playlists` returns `[]`).
  - `class MusicSources { constructor(sources: MusicSource[], d: { defaultSource: () => "local" | "spotify" | "any"; searchLimit: () => number }); status(): Record<MusicSourceId, SourceStatus>; search(query: string, o?: { source?: "local" | "spotify" | "any"; limit?: number }): Promise<{ tracks: SourceTrack[]; notes: string[] }>; track(ref: string): Promise<SourceTrack | null> }` — `search` with `any` merges results round-robin per source and removes duplicates by `ref`; a source that is not connected adds its `needs` text to `notes` instead of failing; a source that throws adds one sentence to `notes`.

- [ ] **Step 1: Write failing tests** with fake sources: default source is used when `source` is omitted; `any` interleaves and de-dupes; a throwing source leaves the other's results and one note; `track("0123456789abcdef")` resolves through `local`; limit is clamped to `searchLimit` max.
- [ ] **Step 2:** Run `npx vitest run src/music/source.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Implement `source.ts`.
- [ ] **Step 4:** Run the test — Expected: PASS.
- [ ] **Step 5:** Commit `feat(music): source interface, registry and local source`.

### Task 4: OAuth module (PKCE, state, token store)

**Files:**
- Create: `packages/server/src/music/oauth.ts`
- Test: `packages/server/src/music/oauth.test.ts`

**Interfaces:**
- Produces:
  - `pkcePair(random?: (n: number) => Buffer): { verifier: string; challenge: string }` (verifier 64 chars base64url, challenge = base64url(sha256(verifier)))
  - `class OAuthStates { constructor(clock?: () => number); issue(source: MusicSourceId, verifier: string): string; take(state: string): { source: MusicSourceId; verifier: string } | null }` — 10-minute expiry, single use, at most 20 pending.
  - `class MusicTokens { constructor(dir: string, clock?: () => number); save(source: MusicSourceId, t: { accessToken: string; refreshToken: string; expiresAt: number; account: string; premium: boolean | null }): void; load(source: MusicSourceId): typeof t | null; forget(source: MusicSourceId): void }` — file `music-<source>.tokens.json`, mode 0600 (same approach as `BrokerSessions`).
  - `async function freshToken(source: MusicSourceId, tokens: MusicTokens, refresh: (refreshToken: string) => Promise<{ accessToken: string; refreshToken?: string; expiresAt: number }>, clock?: () => number): Promise<string | null>` — returns the saved token when it has more than 60 s left, else refreshes once; on refresh failure it forgets nothing, records `reconnect needed` and returns `null`; concurrent calls share one refresh.

- [ ] **Step 1: Write failing tests**: challenge matches the RFC 7636 test vector for a fixed verifier; `take` works once, then `null`; expired and unknown states are `null`; the 21st pending state evicts the oldest; token file is written without ever echoing the token in an error; `freshToken` refreshes at 60 s left, shares one refresh between two simultaneous calls, and returns `null` (no second attempt) when refresh rejects.
- [ ] **Step 2:** Run `npx vitest run src/music/oauth.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Implement `oauth.ts` with `node:crypto` and the same file-handling pattern as `brokers/session.ts`.
- [ ] **Step 4:** Run the test — Expected: PASS.
- [ ] **Step 5:** Commit `feat(music): PKCE, state and token store`.

### Task 5: Spotify source

**Files:**
- Create: `packages/server/src/music/spotify.ts`, `packages/server/src/music/testing/fakeSpotify.ts` (a fake `fetch` that serves `accounts.spotify.com/api/token`, `/v1/me`, `/v1/search`, `/v1/me/playlists`, `/v1/playlists/{id}/tracks`, `/v1/tracks/{id}`)
- Test: `packages/server/src/music/spotify.test.ts`

**Interfaces:**
- Consumes: `MusicSource`, `SourceTrack` (Task 3); `pkcePair`, `OAuthStates`, `MusicTokens`, `freshToken` (Task 4).
- Produces: `class SpotifyHub implements MusicSource { constructor(d: { config: () => Config; tokens: MusicTokens; fetch?: typeof fetch; clock?: () => number; publicBase: () => string }); redirectUri(): string; connectUrl(): string; completeLogin(params: Record<string, string>): Promise<{ ok: true } | { ok: false; error: string }>; disconnect(): void; accessToken(): Promise<string | null> }`. `status()` reports `needs`: `"Add your Spotify client id in Plugins → Spotify."`, `"Connect your Spotify account."`, `"Spotify Premium is needed to play (searching works)."` (when `/v1/me` says `product !== "premium"`), `"Reconnect Spotify."`.
- Scopes requested: `user-read-private user-read-email streaming user-modify-playback-state user-read-playback-state playlist-read-private`.

- [ ] **Step 1: Write failing tests** against `fakeSpotify`: `connectUrl()` contains `code_challenge_method=S256`, the derived redirect URI, a fresh `state`; `completeLogin` with the right state stores tokens and `account`; replayed/expired/unknown state → `{ok:false}` and tokens unchanged; denied (`error=access_denied`) → one plain sentence; `search` maps tracks to `spotify:<id>` refs and respects `limit`; 401 triggers one refresh then one retry; 429 and a non-JSON body each give one sentence and no loop; free account → `status().needs` mentions Premium; redirect URI uses `http://127.0.0.1:<port>` when no `publicUrl`; no test output or thrown message contains the access token.
- [ ] **Step 2:** Run `npx vitest run src/music/spotify.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Implement `spotify.ts`; only the two Spotify hosts may be fetched (reject any other URL).
- [ ] **Step 4:** Run the test — Expected: PASS.
- [ ] **Step 5:** Commit `feat(music): Spotify source with OAuth`.

### Task 6: Routes and wiring

**Files:**
- Modify: `packages/server/src/gateway.ts` (`MusicApi` interface and routes), `packages/server/src/app.ts` (build `MusicTokens`, `OAuthStates`, `SpotifyHub`, `MusicSources`; pass to gateway and hub; apply on settings change like `brokers.apply()`)
- Test: `packages/server/src/music/routes.test.ts` (extend)

**Interfaces:**
- Consumes: Tasks 3–5.
- Produces (owner session required; connect/disconnect/PIN-gated like other plugin changes): `GET /api/music/sources` → `{ sources: { id, status }[] }`; `POST /api/music/spotify/connect` → `{ url }`; `GET /api/music/oauth/callback` (no session cookie needed beyond the `state`; redirects to `/` with `?music=connected` or `?music=failed`); `POST /api/music/spotify/disconnect`; `GET /api/music/search?q=&source=&limit=` → `{ tracks: SourceTrack[]; notes: string[] }`. The existing `/api/music/library` routes keep their shape.

- [ ] **Step 1: Write failing tests**: unauthenticated calls to connect/disconnect/search are refused; callback with a bad state redirects with `failed` and changes nothing; connect without a client id returns the "Add your Spotify client id" sentence; `GET /api/settings`, the `ui` message and `GET /api/music/sources` never contain the token or refresh token.
- [ ] **Step 2:** Run `npx vitest run src/music/routes.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Implement the routes and the `app.ts` wiring.
- [ ] **Step 4:** Run `npx tsc --noEmit` and the test — Expected: PASS.
- [ ] **Step 5:** Commit `feat(music): source routes and wiring`.

### Task 7: Spotify as a plugin (server entry and Configure page)

**Files:**
- Modify: `packages/server/src/integrations.ts` (`IntegrationId` adds `"spotify"`; `INTEGRATION_IDS`, `META`, `PUBLIC_SETTINGS` (`clientId` only), `integrationViews` gets a `spotify` state from `SpotifyHub.status()`, a `changeSpotify(music: MusicConfig, change)` like `changeAlexa`), the integrations route in `app.ts`/`gateway.ts`
- Create: `packages/web/src/plugins/SpotifyForm.tsx`; modify `packages/web/src/plugins/IntegrationConfig.tsx`, `packages/web/src/plugins/pluginsApi.ts`
- Test: `packages/server/src/music/integration.test.ts`, `packages/web/src/plugins/spotify.test.tsx`

**Interfaces:**
- Produces: install/remove/enable follow the existing integration flow (install needs PIN; remove forgets the client id and calls `SpotifyHub.disconnect()`). `SpotifyForm` props: `{ api: SpotifyApi }` where `SpotifyApi = { status(): Promise<{ status: SourceStatus; redirectUri: string; clientId: string }>; saveClientId(id: string, pin: string): Promise<void>; connect(): Promise<string>; disconnect(pin: string): Promise<void> }`; the form shows the redirect URI with a copy button, the client id field, a Connect button (opens the returned URL in the same tab) and the plain `needs` line.

- [ ] **Step 1: Write failing tests**: server — install/enable/remove cycle; remove forgets `clientId` and tokens; the assistant cannot install, enable or set the client id without approval and PIN; web — the form shows the redirect URI, a bad client id is rejected inline, Connect is disabled until a client id is saved, and the Premium note appears from `status.needs`.
- [ ] **Step 2:** Run both test files — Expected: FAIL.
- [ ] **Step 3:** Implement the server entry and `SpotifyForm`; register it in `IntegrationConfig` the way `AlexaForm` is.
- [ ] **Step 4:** Run both tests plus `npx tsc --noEmit` in server and web — Expected: PASS.
- [ ] **Step 5:** Commit `feat(music): Spotify plugin and Configure page`.

### Task 8: Hub and tools use the registry

**Files:**
- Modify: `packages/server/src/music/hub.ts` (`MusicHub` deps gain `sources: MusicSources`; `play`, `queue`, `search`, `nowPlaying` use refs and `source`), `packages/server/src/agent/loop.ts` and `agent/prompt.ts` (tool handlers pass `source`; one paragraph says which sources are connected), `packages/server/src/app.ts`
- Test: `packages/server/src/music/hub.test.ts`, `packages/server/src/agent/music.test.ts` (extend)

**Interfaces:**
- Consumes: `MusicSources.search/track` (Task 3).
- Produces: `PlayArgs`/`QueueArgs`/search args gain `source?: "local" | "spotify" | "any"`; `MusicHub.play`/`search` become `Promise<Result>`; the `music.command` track list carries `ref` in `id` (Task 1). A source that is not connected is reported in the result text with its `needs` sentence; if every chosen source is unavailable nothing is sent to the screen.

- [ ] **Step 1: Write failing tests**: "play Hello on spotify" sends a `play` command whose track id is `spotify:<id>`; `source` omitted uses `defaultSource`; Spotify not connected → result text says to connect it and no command is sent; local-only behaviour (bare ids, existing tests) unchanged; voice-device trust still denies music tools.
- [ ] **Step 2:** Run `npx vitest run src/music src/agent/music.test.ts` — Expected: FAIL.
- [ ] **Step 3:** Implement; update the prompt paragraph.
- [ ] **Step 4:** Run the same tests plus the full server suite (`npx vitest run`) — Expected: PASS, no regressions.
- [ ] **Step 5:** Commit `feat(music): assistant plays from any connected source`.

### Task 9: Screen player — Spotify engine, source tags, grouped results

**Files:**
- Create: `packages/web/src/music/spotifyEngine.ts`
- Modify: `packages/web/src/music/useMusicPlayer.ts` (engine per track), `packages/web/src/music/playerCore.ts` (`Track` gets optional `source`), `packages/web/src/music/MusicPlayer.tsx` (source tag, library/search results grouped by source), `packages/web/src/hud/hud.css` (`.hud-source` tag), `packages/server/src/gateway.ts` (`GET /api/music/spotify/token` → `{ accessToken }` for the owner's session only, used by the SDK's `getOAuthToken`)
- Test: `packages/web/src/music/spotifyEngine.test.ts`, `packages/web/src/music/useMusicPlayer.test.ts` (extend)

**Interfaces:**
- Consumes: `PlayerAudio` (useMusicPlayer.ts line 7), `parseRef` (Task 1), `GET /api/music/search`, `/api/music/spotify/token`.
- Produces: `createSpotifyEngine(d: { loadSdk?: () => Promise<SpotifySdk>; getToken: () => Promise<string>; fetch?: typeof fetch; deviceName?: string }): PlayerAudio & { ready(): Promise<{ ok: true } | { ok: false; reason: string }> }` — implements the same surface as `PlayerAudio` (src/play/pause/seek/volume/ended/timeupdate events) so the reducer and the reporting code are unchanged. It loads `https://sdk.scdn.co/spotify-player.js` only on first use, registers the tab as the device `"Friend"`, and starts a track through `PUT /v1/me/player/play?device_id=…`. `reason` is a plain sentence (Premium needed, SDK blocked, not connected).

- [ ] **Step 1: Write failing tests** with a fake SDK: the script is not loaded until the first Spotify track; a `spotify:` track plays through the engine and a bare id through the audio element; pause/seek/volume go to the engine; engine `ended` advances the queue; "Premium needed" surfaces as the blocked/notice text and the next local track still plays; the source tag renders on each row.
- [ ] **Step 2:** Run `cd packages/web && npx vitest run src/music` — Expected: FAIL.
- [ ] **Step 3:** Implement the engine, the per-track engine choice, the token route and the UI tag; Spotify has no analyser, so the dial uses its existing fallback motion.
- [ ] **Step 4:** Run `npx tsc --noEmit` and `npx vitest run` in web — Expected: PASS.
- [ ] **Step 5:** Commit `feat(music): play Spotify tracks on the Friend screen`.

### Task 10: Docs, full check and release

**Files:**
- Modify: `README.md` (Music section: sources, what each owner needs: "Spotify Premium for playback, a free developer app for the client id, up to five users on a development-mode app"), create `docs/guides/spotify-setup.md` (register the app, paste the redirect URI, client id, Connect, what the errors mean)
- Modify: `packages/friend/package.json` (version)

- [ ] **Step 1:** Write the guide and README text from the spec's "Errors the owner will actually meet".
- [ ] **Step 2:** Run `npx tsc --noEmit` and `npx vitest run` in `packages/protocol`, `packages/server`, `packages/web` — Expected: no FAIL (name any flaky unrelated failure, run it alone).
- [ ] **Step 3:** `pnpm build`, bump `packages/friend/package.json` to the next patch, `npm run bundle` (confirm it does **not** print "web app is older than packages/web/src"), commit and push.
- [ ] **Step 4:** `npm publish` from `packages/friend`, then `friend upgrade` and `friend daemon restart`.
- [ ] **Step 5:** In Chrome, on the owner's own Friend tab: Plugins → Spotify shows the redirect URI and the missing-client-id line; the Music button and the player still work for local files. (The owner completes Connect with their own Spotify login; nothing is typed for them.)
