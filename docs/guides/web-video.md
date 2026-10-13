# Web video (plugin)

Ask Friend to play a video, or a song, from YouTube or almost any other video site. It plays **inside Friend**: on your Friend screen,
in a card with its own controls, or in a window on your PC. It never opens YouTube in your Chrome. It works on Windows, macOS and
Linux, and in any browser, including a phone.

## Set it up: there is nothing to install

1. Open **Plugins**, press **Install** on **Web video** (PIN), then **Turn on** (PIN).
2. That is all. Friend gets the two programs it needs by itself, the first time (about 190 MB, one minute or two):
   **yt-dlp** (finds the video) and **ffmpeg** (makes it playable in the browser). The plugin page shows the progress. If you ask for
   a video before it is done, Friend says it is downloading and to ask again in a minute.

Where the programs come from, and how they are kept safe:
- Each is downloaded over https from its project's own release page (github.com, and one macOS build site), and checked against the
  checksum that project publishes. A download that does not match is thrown away.
- They are kept in Friend's own folder (`tools` inside Friend's data folder) and nowhere else on your PC. Nothing is installed
  system-wide, and nothing needs administrator rights.
- yt-dlp is asked to update itself once a week (sites change often, and an old yt-dlp stops working).
- If you already have yt-dlp or ffmpeg installed, Friend uses yours when you choose its path in Configure; otherwise it uses its own
  copy first and then whatever is on the PATH.
- If you prefer to install them yourself, switch off **Let Friend download yt-dlp and ffmpeg by itself** in Configure (PIN). Configure
  then shows the install command for your system.

## Use it

- "Play lofi hip hop on YouTube", "play this: https://youtu.be/...", "play some Arijit Singh songs on YouTube", "play it on the PC".
- "Pause", "continue", "jump to 2 minutes", "volume 40", "stop the video".
- If a video will not play, ask "why will the video not play": Friend checks the helper programs and tells you what is missing.

Where it plays (Configure, **Where videos play**; one request can say "on the PC"):
- **On the Friend screen:** a card with the browser's own play, volume and full-screen buttons. Friend makes the video as you watch
  (ffmpeg), so nothing is saved to disk; to jump far ahead, ask Friend ("jump to 10 minutes") and it restarts from there.
- **In a window on this PC:** if you have **mpv** installed, a window of its own with full seeking, subtitles and full screen, which
  Friend can pause, seek and set the volume of. Without mpv, Friend opens a **browser window** on this PC with the same video, and
  you use that player's own buttons. mpv is optional and Friend never installs it.

## YouTube plays in YouTube's own player

A YouTube link (or a search for YouTube) shown on the Friend screen plays in YouTube's own embedded player: Friend downloads nothing and ffmpeg is not used. Only a search needs yt-dlp, for the list of results. Some videos are blocked by their owners from playing elsewhere; then ask the assistant to play it again through Friend (it uses `mode: stream`), or set **YouTube plays with** to *Friend's player* in the plugin page to always use yt-dlp and ffmpeg. Other sites always use Friend's player.

## What it will and will not do

- Only public `http` and `https` links. A link that points inside your own network (your router, a printer, `localhost`) is
  refused, whatever it looks like, and so is a link with a login in it or on an odd port.
- A limit on the length (default four hours) and on how many videos stream at once.
- You can give a list of allowed sites; empty means any public site.
- The assistant cannot switch Web video on or change its settings: both need your PIN.
- Some videos cannot be played: private ones, ones that need a login, and ones blocked in your country. Friend says so.
- Playlists, subtitles on the Friend screen, downloads and casting to a TV are not part of this version.
- Respect the terms of the sites you play from. Friend plays a video for you, on your own PC, the way a browser would.
