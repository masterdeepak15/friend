# Starting by itself, and updating by itself

## Start when the computer starts

After a restart Friend is simply there: it starts in the background when you sign in, with no window and no terminal.

- **Settings → Startup → Start Friend when this computer starts** (asks for your PIN), or `friend autostart on`.
- Switch it off the same way (`friend autostart off`).
- Windows: a hidden entry in your own sign-in list (Settings → Apps → Startup shows it as "Friend"). macOS: a launch agent
  (`~/Library/LaunchAgents/com.friend.assistant.plist`). Linux: a user service (`~/.config/systemd/user/friend.service`), or an
  autostart entry when there is no user systemd. Nothing outside your own account is touched, and no administrator is needed.
- Friend keeps working with the Node and the Friend program it was switched on with. An upgrade writes that again by itself.
- On a Linux server without a screen, run `loginctl enable-linger $USER` once so the service starts at boot, before you sign in.

## Updates

Friend looks for a newer version shortly after it starts and every few hours. When there is one:

- **Update Friend by itself** (on by default, Settings → Startup, or `friend config set updates.auto false` to switch it off):
  Friend installs it while it is not busy answering you, then restarts itself. It tells you on the screen first. Reload the page
  afterwards. What happened is written to `update.log` in Friend's data folder.
- **Off:** Friend only tells you a newer version is out. Update with **Update now** in Settings → Startup (asks for your PIN) or
  `friend upgrade`.
- Only a Friend running in the background restarts itself. One you started in a terminal never does: it says to close it and
  run `friend upgrade`.
- The assistant cannot change any of this: only you, on the Settings screen or in the terminal.
