# Connect your Spotify account

Friend can search and play from **your own** Spotify account. You sign in on Spotify's own page (OAuth); Friend never sees your Spotify password, and the sign-in is kept on your PC only. Nothing here costs Friend or its authors anything: whatever Spotify asks for is on your own account.

## What you need

- A Spotify account. **Premium** is needed to *play* on the Friend screen (Spotify's rule for its web player). A free account can be searched, but Friend will say plainly that it cannot play.
- A free developer app of your own at <https://developer.spotify.com/dashboard>. Spotify allows up to **five people** on an app in development mode, which is plenty for one household.
- Friend reachable at an address Spotify accepts as a return address: your public `https://` address, or `http://127.0.0.1:<port>` on the same PC (Spotify does not accept `localhost`).

## Steps

1. Esc → **Plugins** → **Spotify** → **Install** (PIN).
2. Press **Configure**. Copy the **Redirect address** shown there.
3. At developer.spotify.com/dashboard press **Create app**, name it (for example "Friend"), tick **Web API** and **Web Playback SDK**, paste the redirect address, and save.
4. Copy the app's **Client ID** back into Friend's Configure page and press **Save client id** (PIN).
5. Switch the plugin on in the plugins list (PIN).
6. Press **Connect Spotify** (PIN). Spotify's page opens; press **Agree**. You come back to Friend with "Spotify is connected".

Then say or type "play Blinding Lights on Spotify". In the player's Library tab a **Spotify** choice appears for searching by hand.

## Settings

Esc → **Settings** → **Widgets**: *Where music comes from, when the assistant is not told* (folder, Spotify or both) and *Most results from a service*.

## If something goes wrong

| What you see | What it means |
|---|---|
| "Add your Spotify client id…" | Do steps 3 and 4. |
| "Spotify did not connect" after the Spotify page | The redirect address in your Spotify app is not exactly the one shown in Configure, or you pressed Cancel. Fix it and press Connect again. |
| "Spotify Premium is needed to play" | The account is free. Searching works; playing does not. |
| "Reconnect Spotify in Plugins" | Spotify ended the sign-in (for example you removed the app from your account). Press Connect again. |
| "Spotify is asking Friend to slow down" | Spotify rate-limited the app. Wait a minute. |
| Nothing plays, no message | Another browser tab or device may be using Spotify. Close it, then ask again. |
| Someone else cannot connect | A development-mode app allows five people, and each must be added in the app's **User management**. |

## Privacy and safety

- The assistant can never connect, disconnect or change Spotify settings. Connect, disconnect and the client id each ask for your PIN.
- Titles and artist names from Spotify are shown as text only and passed to the assistant as data, never as instructions.
- Remove the plugin (Plugins → Spotify → Remove) to forget the client id and the sign-in at once. You can also remove Friend from your Spotify account page.
