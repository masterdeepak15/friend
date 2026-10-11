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

## Use it from another PC (one address, one port)

Chrome control itself listens on two local ports (8765 for the extension, 8766 for MCP apps). You never need to open or
remember them: Friend serves both on **its own address and port** (for example `https://friend.example.com` or
`http://192.168.1.5:8787`), and passes them on to Chrome control inside your PC.

1. Open **Plugins**, **Chrome control**, **Configure**. Under **From another PC** press **Allow other PCs** and enter your PIN.
   It is off until you do this: while it is off, the two addresses below do not exist.
2. On the other PC, sign in to Friend and press **Download the extension**. Unzip it, open `chrome://extensions`, turn on
   **Developer mode**, press **Load unpacked** and choose the unzipped folder.
3. Press **Show the key** (PIN). In the extension's popup on the other PC, type the **server** address shown in Configure
   (like `wss://friend.example.com/chrome/ws`), paste the key, and engage the link. That Chrome now appears next to yours;
   give each Chrome its own name in the popup.
4. For apps on other PCs (Claude Code, Claude Desktop), use the **MCP address** shown (`https://friend.example.com/chrome/mcp`)
   and send the key as `Authorization: Bearer KEY`.

How it is kept safe: a wrong or missing key gets nothing (and a few wrong guesses lock that address out for a minute); a
website cannot use it (browser pages are refused); the key is only shown after your PIN and is never written to Friend's
logs; and every refused try is recorded. Use `https` (Friend's public address) when the other PC is not on your own network.
Friend's cookie login is not involved: the key is the only way in, so keep it private. Switching **Stop allowing other PCs** off
removes both addresses at once.

## Good to know

- **Removing the plugin** removes Friend's connection only. The helper and the extension stay in `~/.chrome-control-mcp`, because
  other programs on your PC (Claude Code, Claude Desktop) may use the same ones.
- **Upgrading Friend** is safe: when Friend starts it reconnects Chrome control to the copy inside the new version.
- **Already use chrome-control-mcp?** Nothing breaks. Friend's copy uses the same folder and the same token, so the extension you
  already loaded keeps working.
- **From the source code**, run `pnpm build`; Friend finds `packages/chrome-control/dist/index.js`. `FRIEND_CHROME_CONTROL` can
  point at another copy.
- The assistant can offer to install it for you, but it cannot enter the PIN or load the extension: those are yours.
