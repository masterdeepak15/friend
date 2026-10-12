# Web video (plugin)

Ask Friend to play a video from YouTube or almost any other video site, on your Friend screen or in a window on your PC.
It works on Windows, macOS and Linux, and in any browser, including a phone.

## Set it up (once)

1. Install the three free helper programs. Friend never installs them for you and does not ship them: it only looks for them.

   | | Windows | macOS | Linux |
   |---|---|---|---|
   | **yt-dlp** (finds the video) | `winget install yt-dlp` | `brew install yt-dlp` | `pipx install yt-dlp` |
   | **ffmpeg** (plays it on the Friend screen) | `winget install ffmpeg` | `brew install ffmpeg` | `sudo apt install ffmpeg` |
   | **mpv** (the window on the PC, optional) | `winget install mpv` | `brew install mpv` | `sudo apt install mpv` |

   Keep yt-dlp up to date (`yt-dlp -U`): sites change often and old versions stop working.
2. Open **Plugins**, press **Install** on **Web video** (PIN), then **Turn on** (PIN).
3. Press **Configure**. It lists which programs Friend found (press **Check again** after installing one), and lets you choose where
   videos play, the picture quality, the longest video, which sites are allowed, and the program paths if they are in an unusual place.
   Changes need your PIN.

## Use it

- "Play lofi hip hop on YouTube", "play this: https://youtu.be/...", "play it in a window on the PC".
- "Pause", "continue", "jump to 2 minutes", "volume 40", "stop the video".
- If a video will not play, ask "why will the video not play": Friend checks the helper programs and tells you what is missing.

On the **Friend screen** the video is a card with its own buttons. Friend makes the video as you watch (ffmpeg), so nothing is saved
to disk; to jump far ahead, ask Friend ("jump to 10 minutes") and it restarts from there. In a **window on the PC** mpv plays it with
full seeking, subtitles and full screen.

## What it will and will not do

- Only public `http` and `https` links. A link that points inside your own network (your router, a printer, `localhost`) is
  refused, whatever it looks like, and so is a link with a login in it or on an odd port.
- A limit on the length (default four hours) and on how many videos stream at once.
- You can give a list of allowed sites; empty means any public site.
- The assistant cannot switch Web video on or change its settings: both need your PIN.
- Some videos cannot be played: private ones, ones that need a login, and ones blocked in your country. Friend says so.
- Playlists, subtitles on the Friend screen, downloads and casting to a TV are not part of this version.
- Respect the terms of the sites you play from. Friend plays a video for you, on your own PC, the way a browser would.
