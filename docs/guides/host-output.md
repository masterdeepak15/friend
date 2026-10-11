# Play the music from the PC's speakers

By default the music plays in the browser on the Friend screen. You can have the PC that runs Friend play it instead, with no browser open: the screen then shows what is playing and its buttons control the PC. This is also the way to get sound from a PC, a mini PC or a small box with a speaker that has no screen.

## What you need

- **mpv**, a free player, for your folder's music. Install it once:
  - Windows: `winget install mpv` (or `scoop install mpv`, or `choco install mpv`)
  - macOS: `brew install mpv`
  - Linux: `sudo apt install mpv` (Debian, Ubuntu), `sudo dnf install mpv` (Fedora) or `sudo pacman -S mpv` (Arch)
- For **Spotify** on the PC: a Spotify Connect player running on that PC (the Spotify app itself, or any Connect-capable player), signed in to the same Spotify account you connected in Friend. Spotify Premium is needed.

Friend never installs anything itself.

## Steps

1. Esc → **Settings** → **Widgets**.
2. Press **Check mpv**. Friend looks for it on its own and tells you the version, or the exact command to install it. If mpv is somewhere unusual, type its name or a short path in **Program that plays the folder's music** (no spaces and no arguments).
3. Under **Where the sound comes out** choose **This PC's speakers**.
4. For Spotify, type the name Spotify shows for that PC's player in **Spotify device on the PC to play on**.
5. Save (PIN). Say or type "play some Miles Davis". The sound comes from the PC, and the player on the screen says **THIS PC**.

Switching back to **The screen** stops the PC's player and lets the browser play again.

## If something goes wrong

| What you see | What it means |
|---|---|
| "mpv is not installed…" | Install it with the command shown, then try again. |
| "The program set in Settings is not mpv…" | The program setting points at something else. Clear it so Friend can look for mpv, or put the right name or path. |
| "mpv stopped unexpectedly" | mpv closed (or was closed). Play again to start it again. |
| "Several tracks in a row could not be played" | The files were moved or removed, or are not music mpv can read. Rescan the folder. |
| "Name the Spotify device to play on…" | Fill in the Spotify device name in Widgets. |
| "No Spotify device named … Found: …" | The name does not match any device Spotify can see. Start the Spotify player on the PC and use a name from the list. |

## Safety

- Friend gives mpv only files inside your music folder, and it does so through mpv's control channel, never as command-line arguments, so a file's name can never act as an option.
- Only you, with your PIN, can change the output, the program or the device. The assistant cannot.
- Stopping Friend (or changing these settings) ends mpv. If Friend is killed hard (for example from the task manager) mpv may stay open, idle; close it there.
