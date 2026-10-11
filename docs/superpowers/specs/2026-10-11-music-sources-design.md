# Music sources (Spotify, SoundCloud) and where the sound comes out — design

Status: for owner review. Builds on `2026-10-11-music-player-design.md` (the local-folder player, shipped in 0.1.30).

## Why

Friend is self-hosted and meant for anyone. Each owner should be able to connect **their own** Spotify or SoundCloud account to their assistant, with OAuth, and have the assistant search and play from it exactly as it does from the music folder. Any paid plan or approval a service asks for belongs to that owner's own account; Friend never pays, shares or proxies an account. Later the same assistant will run on a small dedicated device with a speaker and a microphone (like an Echo or Google Home), so where the sound comes out must not be tied to a browser.

## Decisions already made with the owner

- Spotify first; SoundCloud second (separate plan and release). JioSaavn is **not** built: it has no public API and its API policy forbids access without issued credentials; every library for it is an unauthorized scraper. The source interface is documented so a licensed source can be added later without touching the player.
- Sign-in is OAuth. The owner never types a Spotify or SoundCloud password into Friend.
- The screen is one place the sound can come out, but it is optional. The PC that runs Friend can be another. A future speaker device is a third. Which one is a setting.
- Everything adjustable is a setting, not a constant. Safety floors stay fixed. The assistant can never connect, disconnect or change a source or the output.

## Parts

### 1. Source interface (server)

`MusicSource` — one per service, registered in a `MusicSources` registry next to the existing `MusicLibrary` (which becomes the `local` source, behaviour unchanged).

- `id`: `local | spotify | soundcloud`
- `status()`: `{ connected: boolean; needs: string | null; account: string | null }` — `needs` is plain words for the owner ("Spotify Premium is needed to play", "App not approved by SoundCloud yet").
- `search(query, limit)`, `playlists(limit)`, `tracksOf(playlistId, limit)`, `track(id)` → `SourceTrack`.
- `SourceTrack = { ref: "<source>:<id>", source, title, artist, album, durationSec | null, cover: string | null }`. `ref` replaces today's bare 16-hex id; a bare id still means `local:<id>` so old queues and saved state keep working.
- `playback(ref)` → how this track can be played: `{ kind: "stream"; path: "/api/music/stream/<ref>" }` (local, SoundCloud) or `{ kind: "spotify"; uri }`.

The agent's music tools (`music.search/play/queue/nowplaying/control`) gain an optional `source` (`local | spotify | soundcloud | any`, default from settings) and return `ref`s. No new tools are needed; the tool descriptions say which sources are connected right now.

### 2. OAuth connections (server)

One small module `music/oauth.ts` used by both services.

- Authorization Code flow with **PKCE** (`S256`), `state` bound to the owner's session and stored with a 10-minute expiry, single use. No client secret is needed for Spotify; SoundCloud's secret, if the owner's app has one, is write-only like the Zerodha secret.
- The owner registers their own free developer app and pastes its **client id** in the plugin's Configure page. The page shows the exact **redirect URI** to copy, built from `publicUrl` (or `http://127.0.0.1:<port>` when there is none; Spotify accepts the loopback address but not `localhost`), so a changed domain changes nothing in the code.
- Routes (owner session required): `POST /api/music/<source>/connect` → `{ url }`; `GET /api/music/oauth/callback` (state-checked, then redirects back to the screen); `POST /api/music/<source>/disconnect`.
- Tokens are stored in the same secret store as other plugin secrets, never sent to the screen, never logged, and refreshed one minute before expiry. A refresh failure marks the source "reconnect needed" and never retries in a loop.
- Connect, disconnect and changing the client id need the owner's PIN (T3 style), and are refused for the assistant like every other plugin setting.

### 3. Plugins and settings

- Two integrations, `spotify` and `soundcloud`, installed from Plugins like Alexa: install (PIN) → Configure (client id, redirect URI to copy, Connect / Disconnect, status line with `needs`).
- `music` settings gain: `sources: { spotify: boolean; soundcloud: boolean }`, `defaultSource: "local" | "spotify" | "soundcloud" | "any"` (default `local`), `searchLimit` 3–50 (default 10), `output: "screen" | "host"` (default `screen`), `hostPlayer: string` (command that plays a file or address on the host, default empty = host output off for local and SoundCloud tracks), `spotifyDevice: string` (the Spotify device name to use for host output, default empty).
- The Widgets tab shows each source's status and the output choice. The folder still works with no source connected.

### 4. Output targets

The existing protocol already has one shape for "something that plays": it receives `music.command` and reports `music.state`. A **target** is anything that does both.

- `screen`: the browser player (today). For Spotify tracks it loads Spotify's Web Playback SDK, which turns that browser tab into a Spotify Connect device (Premium listener account required, stated in the status line). Local and SoundCloud tracks use the existing audio element; the stream path is an authenticated Friend route so no token reaches the browser.
- `host` (the PC that runs Friend): a server-side `HostPlayer` implements the same command/state contract with no browser open. Local and SoundCloud tracks are played by the owner's configured `hostPlayer` command (for example `mpv --no-video`), started and stopped by Friend, paused and resumed through the player's own control channel where it has one and by restart otherwise; Friend ships no audio decoder. Spotify tracks play on the Spotify Connect device named in `spotifyDevice` (the owner can run any Connect-capable player on that PC; Friend only transfers playback and controls it through the Web API). If either is not configured, the status line says what is missing and nothing plays silently.
- Future `speaker` device: a satellite that connects over the same WebSocket, announces itself as a target, receives `music.command` and reports `music.state`. No change to sources or tools is needed when it arrives; this is why host output is built on the target contract and not on the browser.
- `MusicHub` sends a command to the target chosen by `output` (default `screen`), falling back to the newest active screen when the chosen target is not available, with a one-line reason in the assistant's reply.

### 5. Screen changes

The player shows the source as a small tag on each track and in the title area ("SPOTIFY"). Library and search show results from every enabled source, grouped. When Spotify is playing, the dial's bars use the existing gentle fallback motion (Spotify does not expose its audio). Nothing else in the HUD changes.

## Data and safety

- No new secrets on disk beyond tokens in the existing secret store; client ids are not secret and are shown.
- Only `https:` hosts of the two services are ever called; the stream route accepts only refs it can resolve and never a raw address from the assistant or the screen.
- Search text and track metadata from a service are untrusted data, shown as text and passed to the assistant as data, never as instructions.
- Rate limits and failures from a service surface as one plain sentence; there are no retry loops.
- Voice-device trust (Alexa) keeps denying music tools unless the owner allows them.

## Errors the owner will actually meet

Not connected; token expired and refresh failed; Spotify free account (can search, cannot play: say so); developer app over its user limit (Spotify allows five people on a development-mode app: say so); redirect URI mismatch (show the exact URI to copy); service down; output target missing or not configured.

## Testing

Unit: PKCE challenge, state expiry and single use, token refresh timing, ref parsing (bare id = local), registry merge and de-duplication, each error above as one sentence. Contract: a fake `MusicSource` and a fake service server drive search, play, connect and disconnect end to end; `HostPlayer` against a fake player process; hub routing and fallback between targets. Web: source tags, grouped results, the Configure page states, the Widgets tab. No test calls a real service.

## Build order (each its own plan and release)

1. Source layer, `ref` change, OAuth module, Spotify plugin with screen output, and Widgets/Configure UI.
2. Host output (`HostPlayer`, `spotifyDevice`).
3. SoundCloud plugin on the same source layer.
4. (Later project) the speaker-and-microphone device as a target.

## Out of scope

JioSaavn or any unofficial or scraped source; downloading or ripping streamed tracks; Spotify audio analysis for the bars; family-member or per-person service accounts (one owner account per source); playing to other people's Spotify devices; a speaker device (only its contract is designed here).
