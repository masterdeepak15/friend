# The audit trail

Friend writes down what you, your assistant (Maya) and your hired workers do, so that when something goes wrong you can see what happened, who did it and why, and fix it.

## What is recorded

- **Every request**, with a request id that follows it through everything it causes: your typed or spoken request, a Telegram, WhatsApp or SMS message, Alexa, a reminder, a worker's run. A worker's run points back at the request that gave it its ticket.
- **Every tool call**, written before it runs and after, with the exact arguments (secrets masked) and how it ended: done, failed or refused. If the record cannot be written, a tool that changes something is not run and you are told.
- **Every approval**, from the question to the answer: the card text, where it was delivered (screen, Telegram, WhatsApp, SMS, Alexa), who answered and how, from which address, whether a PIN was used (never the PIN), and a timeout when nobody answered.
- **Workers**: each run, each tool, each request they made and who answered it (a rule, the quick check, Maya, you) with the reason, ticket changes and the whole report.
- **You**: logins and failed logins (with address and browser), setting changes (old and new value, secrets masked), what you ask Maya (a household member's or guest's words are never kept), pairing and revoking devices.
- **Maya**: messages she sends for you (recipient and text), things she tells you with `owner.notify`, memory and soul changes, model errors.
- **Outsiders and the system**: failed logins, refused hosts and origins, requests for pages that do not exist (counted when there are many), updates (from and to), start and stop with the version, and a change to the settings file made while Friend was not looking.

Not kept: the words of web searches and the pages the safe browser read (only that it happened), a guest's words, and anything secret (passwords, PINs, keys, tokens, and text that looks like one).

## Reading it

Everything needs your PIN. After it, the audit area stays open for a few minutes (a setting).

- **On the screen**: Esc, Settings, Audit. Filters for when, who, kind and result; "Needs attention" (refused, failed, outsiders, anything that could not be recorded); a button for each worker; "Follow this request" shows the whole story of one request in order; "Verify chain" checks the log; export as JSON, CSV or a printable report.
- **On the command line**: `friend audit list`, `show <request>`, `verify`, `export`, `seal`. It asks for your PIN and gives it to the running Friend; it never opens the database.
- **By asking Maya**: "what did Dev do yesterday?". She uses `audit.search`, which puts a PIN card on your screen every time. Nothing is returned until you type it. What comes back is treated as data, never as instructions.

## Keeping it honest

- Each entry is chained to the one before it (a hash of the previous entry is part of the next). Change or remove one and `friend audit verify` (or the button) names the first entry that no longer fits.
- Once a day (09:00 by default) Friend sends a **seal** to your phone: one line with how many entries exist and the fingerprint of the last. If someone with full access to this PC rewrote the whole log, the chain would still look fine, but the seal in your chat would not match: check it with `friend audit verify --seal "..."`.
- The database refuses to change or delete an entry. Only the retention step may remove old ones, and it writes a checkpoint first (what was removed, and the fingerprint of the last entry), so the chain still verifies and the removal is itself on the record.

## How long it is kept

90 days by default (Settings, Audit, or `friend config set audit.keepDays 365`; 0 keeps everything). Older entries are written to a compressed archive in `audit-archive` in Friend's data folder before they are removed, and the archive can still be checked. Turn the archive off with `audit.archive false`.

## What it cannot do

Someone who controls this PC completely can read the log (it holds private content), and can remove the guard that stops edits. The daily seal on your phone is what lets you notice a rewrite afterwards; keep the seals you care about. A web request is written after it has been answered, so if the database fails at that moment that one request is not recorded.
