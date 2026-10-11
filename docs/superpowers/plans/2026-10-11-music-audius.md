# Audius source Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:executing-plans (native). Steps use checkbox syntax.

**Goal:** Free music from Audius (an open music service) searchable and playable by the assistant and the player, on the screen or the PC, with no account, no key and no payment.

**Architecture:** `AudiusHub implements MusicSource` beside `SpotifyHub` and `SoundCloudHub`. Audius's public API needs only an `app_name` parameter, so there is no OAuth, no secret and no sign-in. A track plays through the same stream route as SoundCloud (`/api/music/stream/audius:<id>`) on the screen, or by an address given to mpv on the PC.

**Tech Stack:** TypeScript, Fastify, vitest, zod (`@friend/protocol`), existing `MusicSources`, `HostPlayer`.

**Spec:** `docs/superpowers/specs/2026-10-11-music-sources-design.md`. Pattern: `2026-10-11-music-soundcloud.md`.

## Global Constraints

- Free only; no account; the only configuration is install and switch on (PIN, owner only). The assistant cannot change it. `music.audius {installed, enabled}`; the zod music schema keeps rejecting it.
- Only `api.audius.co` is called by Friend itself. Audius answers a stream request with a redirect to one of many third-party "content nodes", so a fixed host list is impossible. The trust anchor is Audius's own answer; Friend accepts a redirect only if it is `https:`, the host is a public name (has a dot, not an IP literal, not `localhost`, `.local`, `.internal`), the path starts with `/tracks/cidstream/`, and at most 3 hops. The address (it carries a signature) is never stored, logged or put in an error.
- Every outgoing call has the 8 s timeout. Refs: `audius:<id>` with id `[A-Za-z0-9_-]{1,64}`.
- Search returns only tracks that are streamable and not gated (`is_streamable` true, no `stream_conditions`).

## Review Focus

1. A redirect to a private or odd host (`127.0.0.1`, `10.x`, `localhost`, `.local`, a different path): refused, never fetched.
2. A gated or unlisted track: left out of search; play says so in a sentence.
3. Audius down or slow: one sentence, no hang.
4. Titles with quotes or emoji intact; long ones bounded.
5. A seek (Range) passes through; a client abort closes upstream.

### Task 1: Protocol — id and source
**Files:** `packages/protocol/src/musicRef.ts`, `hud.ts`, `tools.ts`; Test `musicRef.test.ts`.
- [ ] Test: `parseRef("audius:95wro")` ok; `audius:` and `audius:a b` refused; `DEFAULT_SOURCES` and tool `source` accept `audius`. Run RED, implement, GREEN. Commit.

### Task 2: AudiusHub
**Files:** Create `music/audius.ts`, `music/testing/fakeAudius.ts`, `music/audius.test.ts`; modify `config.ts`, `settings.ts`, `music/source.ts`.
**Interfaces:** `class AudiusHub implements MusicSource` deps `{ config; fetch?; requestTimeoutMs? }`; `status()`, `search`, `track`, `playlists`/`tracksOf` (empty), `streamOf(id): Promise<{ok:true;url}|{ok:false;error}>`, `fetchAudio(url, range?, signal?)`; exported `isAudiusAddress(url)`.
- [ ] Tests (fake): status strings; search mapping and filters; track by id; 429/garbage/hang sentences; streamOf follows the API redirect and vets it; refuses private hosts, http, other paths, 4th hop; fetchAudio Range passes through. RED, implement, GREEN. Commit.

### Task 3: Plugin, routes, hub, PC
**Files:** `integrations.ts` (`audius`, `changeAudius`), `app.ts`, `gateway.ts` (stream route dispatches by source), `music/hub.ts` (names), `music/host.ts` (audius branch); tests alongside.
- [ ] Tests: install/enable PIN-gated; stream route plays audius with Range, refuses a bad redirect with no address in the body; hub names Audius; host plays an Audius track through mpv and skips one that will not stream. RED, implement, GREEN. Commit.

### Task 4: Web, docs, release
**Files:** `music/MusicPlayer.tsx`, `useMusicPlayer.ts`, `plugins/IntegrationConfig.tsx`, `settings/*`, `docs/guides/audius-setup.md`, README, version 0.1.34.
- [ ] Tests: AUDIUS tag, Library choice when connected, stream address for the audio element, plugin page has no Save and no form. Full suites, build, bundle, commit, push. Publish only when the owner says.

## Rulings

- Follow the API's redirect to a third-party node (public https host, fixed path) because the node list is dynamic. Cost if wrong: DNS rebinding to a private address in a tiny window; accepted, documented.
