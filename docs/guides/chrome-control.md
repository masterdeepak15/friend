# Chrome control (plugin)

Chrome control lets Friend open pages, read them, click and type in **your own Chrome**, through a small extension. It is a plugin
of Friend: it comes inside the `friend-assistant` package, so you install nothing else (no `npm install -g chrome-control-mcp`, no
`claude mcp add`). It is the same program as the open-source [chrome-control-mcp](https://github.com/masterdeepak15/chrome-control-mcp).

## Set it up

1. Open **Plugins** and press **Install** on **Chrome control**. Enter your PIN. Friend sets Chrome control up in the background
   from the copy it carries: a token, a small helper for Chrome and the extension folder in `~/.chrome-control-mcp`. It does not
   touch Claude's settings, Chrome's shortcuts, or open any window.
2. Press **Configure**. It shows the extension folder (with a **Copy** button). In Chrome open `chrome://extensions`, turn on
   **Developer mode**, press **Load unpacked** and choose that folder. Chrome does not allow programs to install an extension
   silently, so this is the one step only you can do.
3. Click the extension's icon in Chrome and switch it on.
4. Switch the plugin on in the plugins list (PIN). Friend connects. The plugin page says **Connected to your Chrome** when the
   extension is linked; if it says the extension is not linked, repeat step 3.

Every browser action still asks for your approval, and in the extension's popup you can limit it to certain sites. While the
extension is on, Friend can act as you on the sites it allows.

## Good to know

- **Removing the plugin** removes Friend's connection only. The helper and the extension stay in `~/.chrome-control-mcp`, because
  other programs on your PC (Claude Code, Claude Desktop) may use the same ones.
- **Upgrading Friend** is safe: when Friend starts it reconnects Chrome control to the copy inside the new version.
- **Already use chrome-control-mcp?** Nothing breaks. Friend's copy uses the same folder and the same token, so the extension you
  already loaded keeps working.
- **From the source code**, run `pnpm build`; Friend finds `packages/chrome-control/dist/index.js`. `FRIEND_CHROME_CONTROL` can
  point at another copy.
- The assistant can offer to install it for you, but it cannot enter the PIN or load the extension: those are yours.
