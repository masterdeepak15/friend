# Web video (play videos from YouTube and other websites) — design

Status: written by the assistant on the owner's standing instruction to decide and proceed ("do which you think better").
Owner's request (2026-10-12): "we have given media play feature but it cannot play video from youtube or from any other website.
i want my assistant to play videos from the internet (multi-platform). use ffmpeg if needed."

## What the owner gets

Say or type "play <something> on YouTube", or "play this video" with a link from almost any video site. The video plays either
on the **Friend screen** (the browser, also a phone) or in a **window on the PC**, the owner's choice. The assistant can pause, resume,
stop, jump to a time and change the volume. Nothing is downloaded to disk by hand and no account is needed.

## Approach

Friend does not decode video itself. It uses three open-source programs that exist for Windows, macOS and Linux:

| Program | Used for |
|---|---|
| **yt-dlp** | Finds the real video address behind a page (YouTube and about 1,800 other sites) and searches YouTube. |
| **ffmpeg** | Turns what yt-dlp found into something every browser can play, as it arrives (H.264 video + AAC audio in a fragmented MP4). |
| **mpv** | The PC window (already used by the music player). mpv uses yt-dlp itself, so it plays the same links with seeking and subtitles. |

**Update (same day, the owner's instruction "no manual installation"):** Friend downloads yt-dlp and ffmpeg by itself when the plugin
is installed or turned on, into its own tools folder (https only, from the projects' release pages, SHA-256 checked, a setting can
turn it off), and keeps yt-dlp current. mpv stays the owner's: without it the PC output is a browser window on the PC, opened with a
single-use ticket address. Nothing is bundled in the npm package (size, licences).

## Two outputs

1. **Screen.** `video.play` makes Friend resolve the link (yt-dlp), then shows a `video` card on the stage whose source is
   `/api/video/<id>`: a Friend address, not the remote site. Friend streams it by running ffmpeg on the real address and piping
   a fragmented MP4 to the browser. One stream at a time per card; the process stops when the browser leaves, the card closes or
   another video starts. Seeking in the browser works inside what has arrived; to jump further the assistant restarts the stream at a
   time (`start`).
2. **PC.** mpv opens a window on the PC with the link (its own yt-dlp hook), controlled over mpv's IPC like the music player: pause,
   resume, seek, volume, stop. Needs mpv and yt-dlp only.

`video.output` (a setting) chooses the default: `screen` or `pc`; the tool may pass `output` for one request.

## Safety floors (fixed, not settings)

- Only `http` and `https` links; no `file:`, no `ftp:`, no logins in the link, no odd ports.
- The link's name, and the media addresses yt-dlp finds, must resolve only to **public** addresses (no localhost, private,
  link-local or reserved ranges). Same check as Audius, applied at every step.
- yt-dlp runs with a fixed command line: `--ignore-config --no-playlist --no-exec --no-cookies-from-browser`, a time limit, and the
  program path comes only from the owner's settings. ffmpeg runs with `-protocol_whitelist http,https,tcp,tls,crypto`.
- A cap on streams at once, on length, and on how long a resolved link is remembered.
- The stream route needs the owner's signed-in session. The stage may only show `/api/media/<id>` or `/api/video/<id>` sources.
- The assistant cannot switch the plugin on or change its settings: both need the owner's PIN (like Audius, Spotify, Chrome control).

## Settings (the owner's knobs)

`video { installed, enabled, output: "screen"|"pc", maxHeight: 360..1080 (720), maxMinutes (240), allowedSites: string[] (empty = any
public site), ytdlp: "" , ffmpeg: "" }` — a program path left empty means "find it on this PC". Shown on the plugin's Configure page
with the helper check; changed with the PIN.

## Tools (for the assistant)

- `video.play { url? | query?, output?, start? }` — a link or words to search on YouTube; says what is playing.
- `video.control { action: pause|resume|stop|seek|volume, seconds?, level? }`.
- `video.check {}` — what is found and what to install (so the assistant can tell the owner in plain words).

Approval: playing and controlling need none (like music); they are allowed to Friend's own voice but never to Alexa or to a guest.

## Out of scope for this version

Playlists and queues of videos, subtitles on the screen path, downloads to a file, sites that need the owner's login (cookies),
live streams on the screen path (they work on the PC), casting to a TV.

## Testing

Unit tests with a fake yt-dlp / ffmpeg / mpv (injected program runner), a route test that streams bytes through `/api/video/<id>`,
the address checks, and a live check on this PC with the real programs once they are present.
