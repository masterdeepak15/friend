# Connect your SoundCloud account

Friend can search and play from **your own** SoundCloud account. You sign in on SoundCloud's own page (OAuth); Friend never sees your SoundCloud password, and the sign-in is kept on your PC only. Nothing here costs Friend or its authors anything: whatever SoundCloud asks for is on your own account.

## What you need

- A SoundCloud account.
- A free app of your own, registered at <https://soundcloud.com/you/apps>. **SoundCloud decides who can register an app**, and it may take a while or be closed for new apps. At the time of writing the registration page may ask for a paid SoundCloud plan; Friend never pays for or shares an account, so skip this plugin if that is the case. If you cannot get an app, this plugin cannot be used; the music folder and Spotify still work.
- The app's **Client ID** and **Client Secret**. Friend keeps the secret in its own file in your data folder (readable by you only) and never shows it again, never sends it to a screen and never gives it to the assistant.
- Friend reachable at an address SoundCloud accepts as a return address: your public `https://` address, or `http://127.0.0.1:<port>` on the same PC.

Some tracks cannot be streamed to apps (blocked in your country, or only for a SoundCloud paid plan). Friend leaves those out of search and skips them in a queue.

## Steps

1. Esc → **Plugins** → **SoundCloud** → **Install** (PIN).
2. Press **Configure**. Copy the **Redirect address** shown there.
3. In your SoundCloud app's settings, paste the redirect address and save.
4. Copy the app's **Client ID** and **Client Secret** into Friend's Configure page and press **Save** (PIN).
5. Switch the plugin on in the plugins list (PIN).
6. Press **Connect SoundCloud** (PIN). SoundCloud's page opens; allow Friend. You come back to Friend with "connected".

Then say or type "play Midnight City on SoundCloud". In the player's Library tab a **SoundCloud** choice appears for searching by hand.

## Where it plays

- **On the screen** (default): Friend fetches the audio with your login and plays it in the browser, with seeking.
- **On the PC's speakers** (Settings → Widgets → *Where the sound comes out*): mpv plays SoundCloud tracks from a short-lived address SoundCloud gives at the moment each track starts. Only addresses on SoundCloud's own hosts are ever used. If an address runs out mid-track, Friend asks for a new one once, then moves on. See `host-output.md` for installing mpv.

## If something goes wrong

| What you see | What it means |
|---|---|
| "Add your SoundCloud client id and secret…" | Fill both in on the Configure page and save. |
| "Reconnect SoundCloud in Plugins, SoundCloud." | SoundCloud no longer accepts the saved sign-in. Press Connect again. |
| "SoundCloud does not let this account play that track." | The track is blocked or preview-only for your account. |
| "SoundCloud is asking Friend to slow down." | Too many requests; try again in a minute. |
| "SoundCloud sent the audio somewhere Friend will not follow." | The audio address was not one of SoundCloud's own, so Friend refused it. |

## Safety

- Only you, with your PIN, can change the client id and secret, connect or disconnect. The assistant cannot.
- Friend only talks to `secure.soundcloud.com`, `api.soundcloud.com` and SoundCloud's own audio hosts, over https, with at most three redirects, and the audio address is never stored or written to a log.
