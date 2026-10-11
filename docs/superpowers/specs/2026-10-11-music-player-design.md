`# Music player: a HUD media player the assistant fully controls
`
`Date: 2026-10-11. Status: draft for the owner's review.
`
`## What the owner asked for
`
`A music player inside Friend that plays from a **configurable music folder**, looks like the media player of the Rainmeter **S.H.I.E.L.D. Interface** skin (checked from the owner's screenshot) drawn in Friend's own HUD theme, and is **controlled by the assistant with every control**. Playback happens in the Friend screen (so it comes out of whichever device has Friend open). First version: playlist, shuffle, repeat, volume, search, cover art and tags from the files, and assistant control by voice or text. Alexa control is a later step.
`
`## The look (from the S.H.I.E.L.D. screenshot, in Friend's colours)
`
`- **Dock bar** (the S.H.I.E.L.D. bottom-right media strip): a thin timeline with elapsed and remaining time at its ends, three angled (chamfered) buttons previous / play-pause / next, and a round dial at its end. Always available as the small view.
`- **Dial**: a ring that shows progress as an arc, with the cover art in the middle (a plain emblem when there is none), radial spectrum bars that move with the music, and a sweeping needle while playing. This replaces the radar of the skin.
`- **Level bars**: two vertical blue bars (left and right level) like the skin's side meters; volume is a slim bar beside them.
`- **Playlist**: stacked angled tabs like the skin's left menu ("Safari", "Media Player"): the current track highlighted, search box on top, scrolls inside a fixed frame.
`- Dark grid background, thin lines, small caps labels, glowing accent. The accent and the HUD theme come from the owner's look settings; no colours are hardcoded.
`- Two views: **mini** (the dock bar) and **full** (dial, levels, playlist). The assistant can switch between them or hide the player.
`
`## What is configurable (settings block \`music\`, PIN to save, assistant cannot change it)
`
`| Setting | Default | Range |
`|---|---|---|
`| \`folder\` | empty (player off until the owner chooses a folder) | a folder on this PC |
`| \`extensions\` | mp3, m4a, aac, ogg, opus, wav, flac | subset of what the browser can play |
`| \`maxTracks\` | 5000 | 100 to 50000 |
`| \`scanDepth\` | 6 | 1 to 12 sub-folder levels |
`| \`volume\` | 70 | 0 to 100 |
`| \`shuffle\`, \`repeat\` (off / all / one) | off, all | |
`| \`visualizer\` | on | on / off (saves CPU on weak devices) |
`| \`startView\` | mini | mini / full |
`
`## How it works
`
`**Library (server).** \`music/library.ts\` walks the folder (depth, count and extension limits), reads tags and the cover with the free \`music-metadata\` library (title, artist, album, track, duration; falls back to the file name), and keeps the list in memory. A rescan happens on demand, when the folder setting changes, and when the owner opens the player. Each track has an id (a hash of its path inside the folder); real paths are never sent to a screen.
`
`**Safe by design.** Only the owner's signed-in session can list or stream. The server resolves every file with \`realpath\` and refuses anything outside the configured folder (including symbolic links that point out), anything that is not an allowed audio extension, and any id it did not make. Responses never contain paths. Streaming supports HTTP Range so seeking works. Rate limits apply.
`
`**Routes.** \`GET /api/music/library?q=&offset=&limit=\`, \`GET /api/music/track/:id\` (audio, with Range), \`GET /api/music/cover/:id\` (embedded picture, or folder.jpg / cover.jpg / front.jpg next to the file; size capped), \`POST /api/music/rescan\`.
`
`**Player state (screen).** The browser page owns playback (\`<audio>\`, the Web Audio analyser for the bars, the Media Session API so phone lock screens and headset keys work). It reports its state (track, position, volume, shuffle, repeat, queue length, playing) to the server; the server keeps the latest one so the assistant can answer "what is playing".
`
`**Assistant control (all controls).** New tools, no approval card because they only play the owner's own files on their own screen (a tier below the "ask" level):
`
`| Tool | What it does |
`|---|---|
`| \`music.play\` | play by a search ("some jazz", an artist, an album, a song), or resume the queue; optionally replace or add to the queue and start shuffled |
`| \`music.control\` | pause, resume, stop, next, previous, seek (seconds or percent), volume (set or step), mute, shuffle, repeat (off/all/one), and view (mini / full / hide) |
`| \`music.queue\` | add by search, remove, clear, show the queue |
`| \`music.search\` | list tracks, artists or albums that match, with the counts |
`| \`music.nowplaying\` | track, artist, album, position, length, volume, shuffle, repeat |
`
`Commands travel as a \`music.command\` message to the open screen; if no Friend screen is open the tool says so (nothing can play without one). Browsers block sound until the page has had a click or tap, so the first command after opening the page may need one tap: the page shows the same one-time "tap to enable sound" hint it uses for speech.
`
`The assistant's prompt gets a short paragraph (what the tools do, say what is playing in a few words, never read out file paths).
`
`## Out of scope for the first version
`
`Alexa control and streaming (a later step, using the same tools), playlists saved by the owner (the queue is in memory), lyrics, equaliser, online music services, and playing on the PC speakers with no screen open.
`
`## Tasks (outline)
`
`1. Settings: \`music\` block in config and the settings screen, validation, refused for the assistant.
`2. Library: scan, tags, cover, search, safety (containment, symlinks, extensions), tests with a temporary folder.
`3. Routes: library, streaming with Range, cover, rescan; auth and rate limits; tests.
`4. Protocol and tools: \`music.command\` and \`music.state\` messages, the five tools, handlers, prompt paragraph; tests.
`5. The player screen: dock bar, dial with spectrum, level bars, playlist tabs, search, Media Session, keyboard, settings fields; tests.
`6. A look check in the real browser against a throwaway Friend with a small test folder, then adjust.
`7. Docs (guide and README), full verification, release.
