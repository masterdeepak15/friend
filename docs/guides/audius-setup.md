# Free music from Audius

Audius is an open music service, mostly independent artists. Its public catalog needs **no account, no key and no payment**, so there is nothing to sign in to: you install the plugin and switch it on.

## Steps

1. Esc → **Plugins** → **Audius** → **Install** (PIN).
2. Switch the plugin on in the plugins list (PIN).

Then say or type "play some lofi on Audius". In the player's Library tab an **Audius** choice appears for searching by hand. *Settings → Widgets → Where music comes from* can make Audius (or All) the default.

## Where it plays

- **On the screen** (default): Friend fetches the audio from Audius and plays it in the browser, with seeking.
- **On the PC's speakers** (Settings → Widgets → *Where the sound comes out*): mpv plays the track from a short-lived address Audius gives at the moment it starts. See `host-output.md` for installing mpv.

Tracks that Audius gates (paid or follower-only) or that are not streamable are left out of search.

## If something goes wrong

| What you see | What it means |
|---|---|
| "Install and switch on Audius in Plugins." | The plugin is not installed or is switched off. |
| "That Audius track cannot be played." | The track is gated, removed, or not streamable. |
| "Audius is asking Friend to slow down." | Too many requests; try again in a minute. |
| "Friend could not reach Audius right now." | Audius (or the network) did not answer in time. |
| "Audius gave no playable address…" / "…somewhere Friend will not follow." | Audius pointed to an address Friend refuses (see Safety). |

## Safety

- Only you, with your PIN, can install or switch it on. The assistant cannot.
- Friend itself only calls `api.audius.co`. Audius answers a stream request with a redirect to one of many audio servers run by other people, so Friend cannot keep a fixed list of them. It accepts such an address only if it is plain `https`, a public name (not an address number, not `localhost`, not a local or reserved name, no login, no odd port) with the stream path, **and** every address the name resolves to is a public one (a name that points at your own network is refused). At most three redirects, each checked the same way. The address (it carries a signature) is never stored or logged.
- **On the screen** every hop is checked by Friend. **On the PC**, Friend checks the first address and then hands it to mpv, which follows any further redirect itself (mpv is started with certificate checking on). A hostile audio server could therefore send mpv on to something else; if that worries you, play Audius on the screen.
- The name check and the fetch are two steps, so a name that changes its answer in between could slip through; this is a small window and is accepted.
