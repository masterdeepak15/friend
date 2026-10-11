# SoundCloud source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans (native) to implement this plan task by task. Steps use checkbox syntax.

**Goal:** The owner connects their own SoundCloud app and account with OAuth; the assistant searches and plays SoundCloud tracks on the screen or on the PC, like Spotify.

**Architecture:** `SoundCloudHub implements MusicSource` beside `SpotifyHub`, reusing `oauth.ts` (PKCE, state, token file, single-flight refresh). SoundCloud tracks play as a stream: the server fetches the track's stream with the owner's token and serves it at `/api/music/stream/soundcloud:<id>` (Range supported) to the screen's audio element. On the PC, the server resolves the stream to its temporary https address and gives that to mpv through the same IPC `loadfile`.

**Tech Stack:** TypeScript, Fastify, vitest, zod (`@friend/protocol`), existing `oauth.ts`, `MusicSources`, `HostPlayer`, `Mpv`.

**Spec:** `docs/superpowers/specs/2026-10-11-music-sources-design.md` (SoundCloud second, own plan and release). Plan 1: `2026-10-11-music-sources-spotify.md`. Plan 2: `2026-10-11-music-host-output.md`.

## Global Constraints

- Free only. SoundCloud API access, app approval and any Go+/Artist plan are the owner's own account matters; Friend never pays, shares accounts or scrapes. Status `needs` says it in plain words ("Register an app at SoundCloud and paste its client id", "App not approved by SoundCloud yet", "Go+ track: not playable with this account").
- Official API only (`secure.soundcloud.com` for OAuth, `api.soundcloud.com` for data). No unofficial client-id harvesting.
- OAuth Authorization Code + PKCE `S256`, single-use 10-minute `state`, tokens in the data folder `music-soundcloud.tokens.json` mode 0600, refresh 60 s early, `RefreshRejected` marks reconnect.
- The client secret, if the app has one, is write-only like the Zerodha secret (never returned by any route or setting). The client id and redirect URI are shown.
- All SoundCloud settings (`music.soundcloud {installed, enabled, clientId}`) are PIN-protected and refused for the assistant; the zod settings schema rejects `music.soundcloud`.
- Refs: `soundcloud:<numeric id>`. `MusicSourceId` gains `soundcloud`; ref and queue-id max length stays 80.
- Every outgoing call has the 8 s timeout. The stream proxy only talks to https hosts on `soundcloud.com`, `sndcdn.com` and their subdomains (no redirect to anywhere else).
- Safety floors stay fixed; the PC player still gets only a local-folder path or a validated https address, always through IPC, never as an argument.

## Review Focus

1. A stream address that expires mid-track or a redirect to a foreign host: refused or refetched, with a sentence, never played from an unvetted host.
2. A track that is blocked, geo-limited or Go+ only: search marks it unplayable, play says so in one sentence, the queue skips it.
3. A token refresh failing permanently during playback: the owner sees "Reconnect SoundCloud" once, nothing loops.
4. A range request (seek) on the proxy: partial content passes through with correct headers; a client abort closes the upstream fetch.
5. A title with quotes, emoji or a very long description: replies and settings stay intact and bounded.

---

### Task 1: Protocol — ids, settings, source flag

**Files:** Modify `packages/protocol/src/musicRef.ts`, `hud.ts`, `messages.ts`; Test `packages/protocol/src/musicRef.test.ts`, `hud.test.ts`.

**Interfaces:**
- Produces: `MUSIC_SOURCES` includes `"soundcloud"`; `parseRef("soundcloud:123")` → `{source:"soundcloud", id:"123"}` (digits only, max 20) and `makeRef`; `DEFAULT_SOURCES` allows `soundcloud`; settings schema rejects a `music.soundcloud` key from the assistant path; `MusicSourceId` type widened.

- [ ] Step 1: tests — `parseRef` accepts `soundcloud:123456`, rejects `soundcloud:abc`, `soundcloud:`, a 21-digit id; `defaultSource: "soundcloud"` valid; settings update containing `music.soundcloud` rejected.
- [ ] Step 2: run protocol tests, expect FAIL. Step 3: implement. Step 4: run, expect PASS (protocol suite green).
- [ ] Step 5: commit `feat(protocol): soundcloud refs and default source`.

### Task 2: SoundCloudHub — OAuth, search, tracks

**Files:** Create `packages/server/src/music/soundcloud.ts`, `music/testing/fakeSoundCloud.ts`, `music/soundcloud.test.ts`; Modify `music/source.ts` (NAMES gains `soundcloud`).

**Interfaces:**
- Consumes: `oauth.ts` helpers (as `SpotifyHub` uses them), `SourceTrack`, `MusicSource`.
- Produces: `class SoundCloudHub implements MusicSource` with deps `{ clientId(): string; clientSecret(): string; redirectUri(): string; dataDir; fetch; clock; requestTimeoutMs? }` and methods `status()`, `startLogin()`, `completeLogin(params)`, `disconnect()`, `accessToken()`, `search(q, limit)`, `playlists(limit)`, `tracksOf(id, limit)`, `track(id)`, `streamOf(id): Promise<{ok:true; url:string}|{ok:false; error:string}>` (the vetted https address of the stream).
- `search` maps `GET /tracks?q=&limit=&access=playable`; marks `canPlay` false tracks out (not returned); `durationSec` from ms; `title`/`artist` (user.username) trimmed to 200.

- [ ] Step 1: tests against `fakeSoundCloud` (authorize → token with PKCE verifier checked; state single use and expiry; refresh single-flight and permanent rejection → `needs: "Reconnect SoundCloud"`; search mapping and limit; playable-only; `status()` strings for no client id, not connected, connected with account name; 8 s timeout on a hung call; secret never in any returned value).
- [ ] Step 2: run, expect FAIL (module missing). Step 3: implement mirroring `spotify.ts` structure. Step 4: run, expect PASS.
- [ ] Step 5: commit `feat(music): SoundCloud source (OAuth, search, tracks)`.

### Task 3: Stream address vetting and the proxy route

**Files:** Modify `music/soundcloud.ts` (`streamOf`), `packages/server/src/gateway.ts` (`GET /api/music/stream/:ref`), `app.ts` (`MusicApi.stream`); Test `music/soundcloudStream.test.ts`, `music/stream.routes.test.ts`.

**Interfaces:**
- Produces: `streamOf(id)` follows `GET /tracks/:id/stream` redirect manually (max 3 hops), accepts only `https:` hosts matching `/(^|\.)(soundcloud\.com|sndcdn\.com)$/`, returns the final address; `MusicApi.stream(ref, range?)` → `{status, headers, body: ReadableStream}` or `{error}`; route behind `musicGuard`, streams with `Range`, `Content-Type: audio/mpeg` (or upstream's), `cache-control: no-store`, aborts upstream on client close.

- [ ] Step 1: tests — redirect to a foreign host refused with a sentence; `http:` refused; 4th hop refused; range request gets 206 with `content-range`; client abort cancels the upstream; unknown/unconnected source → 404 with a sentence; the address (with its signature) never appears in an error text or the log.
- [ ] Step 2: run, expect FAIL. Step 3: implement. Step 4: run, expect PASS. Step 5: commit `feat(music): SoundCloud stream proxy with host vetting`.

### Task 4: Registry, hub routing, integration, routes

**Files:** Modify `integrations.ts` (`soundcloud` id, `changeSoundcloud`), `config.ts`, `settings.ts`, `app.ts` (build the hub, add to `MusicSources`, `music.soundcloud` settings, callback shared by both providers), `gateway.ts` (`POST /api/music/soundcloud/{connect,disconnect}`, `POST /api/music/soundcloud/client-id` PIN route; the OAuth callback dispatches by `state` owner), `music/hub.ts` (play/queue through the registry already; screen playback of a soundcloud ref sets the track `src` to `/api/music/stream/<ref>`); Tests `soundcloud.routes.test.ts`, `hub.test.ts` additions, order tests append `soundcloud`.

**Interfaces:** Produces `INTEGRATION_IDS` + `soundcloud`; `GET /api/music/sources` includes `soundcloud` status; tool descriptions list connected sources.

- [ ] Step 1: tests — install/enable/uninstall PIN-gated and refused for the assistant; secret write-only; callback with a Spotify state still completes Spotify and a SoundCloud state completes SoundCloud, a reused state fails; `music.search` with `source:"soundcloud"` and `"any"`; play of `soundcloud:1` on screen sends a track with the proxy address; unconnected → the `needs` sentence.
- [ ] Step 2: run, expect FAIL. Step 3: implement. Step 4: run, expect PASS. Step 5: commit `feat(music): SoundCloud plugin, routes and routing`.

### Task 5: PC output for SoundCloud

**Files:** Modify `music/host.ts` (drive a soundcloud track), `music/mpv.ts` (`loadUrl`, https and vetted host only, via IPC `loadfile`); Tests `host.test.ts`, `mpv.test.ts`, `testing/fakeMpv.mjs` unchanged where possible.

**Interfaces:** Consumes `SoundCloudHub.streamOf`. Produces `Mpv.load(target)` accepts a vetted https address as well as a folder path (still never an argument); `HostPlayer` resolves the address at the moment a track starts (never stores it), and on `failed` for an expired address refetches once before skipping.

- [ ] Step 1: tests — a soundcloud track is loaded by IPC with the resolved address; an unvetted address never reaches mpv; one refetch on failure then the normal skip count; reply says "on this PC".
- [ ] Step 2–4: RED, implement, GREEN. Step 5: commit `feat(music): SoundCloud on the PC through mpv`.

### Task 6: Screen UI, docs, release

**Files:** Create `packages/web/src/plugins/SoundCloudForm.tsx`; Modify `plugins/IntegrationConfig` branch, `MusicPlayer.tsx` (SOUNDCLOUD tag), `settings/WidgetsTab.tsx` (`defaultSource` option), `docs/guides/soundcloud-setup.md`, README music line, `packages/friend/package.json` → 0.1.33; Tests `plugins/soundcloud.test.tsx`, `widgets.test.tsx`.

- [ ] Step 1: tests — form shows client id and the redirect URI to copy, Connect opens the authorize address, status line shows `needs`, secret field is write-only, Disconnect works; the player shows the SOUNDCLOUD tag; default source offers SoundCloud.
- [ ] Step 2–4: RED, implement, GREEN. Step 5: full suites (protocol, server, web) green; `pnpm build`; `npm run bundle`; commit `release: 0.1.33 (SoundCloud)`; push. Publish only on the owner's go-ahead.

### After the tasks

One fresh opus reviewer on the whole branch with the Review Focus above; fix Critical/Important in one RED→GREEN pass; Minors go to the ledger. Owner steps (PIN, own accounts): register an app at SoundCloud, paste its client id, Connect.

## Rulings so far

- The PC player receives a resolved temporary https address, not the app's own proxy, because mpv has no session for the proxy's login. Cost if wrong: an address that expires mid-track is refetched once, then the track is skipped with a sentence.
- Playlists/likes beyond search and the owner's own playlists are not in this plan.
