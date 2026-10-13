# Searching the web

Friend can look things up on the internet, so a question about today ("what is the share market today?", news, prices, scores)
is answered from what it finds, with the source named, and not from memory. It works from voice, chat, WhatsApp and scheduled
tasks, with no browser open.

## Two ways, and they work together

- **Claude's own search** (Claude Code model only): on by default, Settings → Model → **Let Claude search the web**
  (`claudeCode.webSearch`). Only searching: Claude gets no other built-in tool, and a guest never gets it.
- **Friend's tools `web.search` and `web.read`** (every model): Settings → Model → **Searching the web** (`web.enabled`).
  - `web.search` gives a numbered list of results (title, link, snippet).
  - `web.read` gives the text of one page, up to about 12,000 characters.

## Where the searches come from

`web.provider` picks one: **DuckDuckGo** (default, free, no key; it is a page made for people, so it can change or turn Friend
away), **Brave Search** or **Tavily** (your own key), or **SearXNG** (your own server). If the chosen source cannot answer, Friend
tries DuckDuckGo once and says so; if nothing works it says it could not search and does not guess.

Keys are write-only: they are never shown again and only the owner can change them on the Settings screen.

## Safety

- Everything that comes back from the internet is marked as untrusted data. A page that says "ignore your instructions" is just text.
- `web.read` only opens public web pages: no addresses on this PC or your network, no logins in the link, no odd ports. The check
  runs again on every redirect (at most 4), so a page cannot send Friend inwards.
- web.read asks for your yes (a card showing the whole address) when the address is one nobody gave it: not typed or said by you, and not returned by a search in the same request. This stops a page from talking Friend into sending private data out inside an address.
- The connection itself is checked too: Friend only connects to public addresses, even if a name starts pointing inside after the check.
- 10 seconds at most, 2 MB at most (and only the first part of a page is read), text pages only. Nothing is run or saved, and no cookies or logins are sent.
- The owner gets both tools. A recognized household member gets `web.search` only. Guests and Alexa get neither.
- The audit log records each search (the words searched, the source, how many results) and each page read (the site only).