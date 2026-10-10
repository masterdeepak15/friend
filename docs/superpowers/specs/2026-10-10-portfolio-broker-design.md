# Portfolio and broker integration (Zerodha first, read only) - design

Date: 2026-10-10. Status: approved in conversation, awaiting written-spec review.

## 1. Purpose and scope

The owner wants Friend to read their stock-market account and report on it, by voice, chat, and on a schedule delivered to
Telegram or WhatsApp, at no extra cost and with no third-party service in between. Zerodha (Kite Connect) is the first
broker. Others (Angel One, Upstox, Dhan, ...) must be addable later without touching reports, tools, the skill or the
screens.

**In version 1 (read only):**
- Read holdings, positions, funds and margin, today's orders and trades, GTTs, alerts, mutual-fund holdings and SIPs.
- Compute portfolio value, today's change and profit/loss, biggest gainers and losers among the owner's own holdings,
  concentration.
- Scheduled and on-demand reports to the owner's linked Telegram chat or WhatsApp number.
- A broker-independent skill that keeps the AI factual.
- A "Trading" settings page with the permission level (Read only active; order levels shown as locked, "later version").

**Not in version 1:** placing, changing or cancelling orders (no such code exists, so no setting can enable it by mistake);
quotes or streaming for stocks the owner does not hold; historical data; any third-party data or server.

**Cost.** Zerodha's free Personal plan covers orders, portfolio, margins, GTT and alerts but not quotes, live streaming or
historical data; those need the paid Connect plan (about 500 rupees a month per Zerodha's support pages, to be re-checked
when building). Holdings and positions carry their own last price, day change and profit/loss, which gives "live" figures
for what the owner holds without the paid plan. If the owner later buys the paid plan, a `quotes` capability can be added
to the provider without redesign.

**Advice boundary.** The AI describes what the numbers show. It never says buy or sell, predicts prices, or gives
personalized investment advice (Friend is not a licensed adviser). "Things worth a look" in reports are factual flags
(concentration, large drops), not recommendations.

## 2. Architecture

### 2.1 The broker contract (reuse and upgrade path)

`server/src/brokers/types.ts` defines the only thing the rest of Friend knows about a broker:

```
interface BrokerProvider {
  id: string                       // "zerodha", later "angelone", ...
  name: string
  capabilities: { holdings; positions; funds; orders; mutualFunds; quotes; placeOrders }  // booleans
  login: LoginFlow                 // see 2.3
  session(): SessionState          // { valid, expiresAt, detail }
  holdings(): Promise<Holding[]>
  positions(): Promise<Position[]>
  funds(): Promise<Funds>
  orders(): Promise<Order[]>       // today's
}
```

Shared normalized models (`Holding`, `Position`, `Funds`, `Order`) use plain numbers in rupees, ISO timestamps and one
symbol shape (`exchange:symbol`). Each provider maps its broker's fields into these and declares what it cannot do
(`quotes: false` for the free Zerodha plan). Reports and the AI read `capabilities` and adapt (they omit what is not
there and say so). `placeOrders` exists in the type, is `false` for every provider in v1, and no code path in v1 reads it.

Adding a broker = one provider file under `brokers/`, one entry in the broker catalog, one fixture set for the shared
contract test. Nothing else changes.

### 2.2 Portfolio service

`server/src/brokers/portfolio.ts` sits above the active provider: caches reads for a short time (default 30 seconds) so
chat, the AI and reports never exceed the broker's rate limits, and computes the summary (value, invested, profit/loss,
day change, top gainers and losers, concentration by holding and by sector-less top-N, funds). It never mutates anything
and has no knowledge of any broker's wire format.

### 2.3 Login (provider-owned, no third party)

A provider's `LoginFlow` is one of:
- `redirect`: Friend builds the broker's login URL; the owner logs in on the broker's own page (password and 2FA never
  touch Friend); the broker sends the browser back to Friend with a one-time code; Friend completes the exchange. This is
  Zerodha's flow.
- `credentials`: the provider lists the fields it needs (reserved for brokers that log in with client code, PIN and TOTP;
  not used in v1).

Zerodha: login URL `kite.zerodha.com/connect/login?v=3&api_key=...` with a Friend-made one-time `state` passed through
the broker's redirect parameters; Friend's return route `GET /api/brokers/zerodha/callback` checks the `state`, then
exchanges `request_token` with the API secret's checksum for an access token, which expires each morning (about 06:00 IST).
The return route needs Friend to be reachable from the owner's phone or browser (the owner's public address, or the local
address when logging in on the PC); the redirect URL is registered in the owner's Kite developer app.

### 2.4 Integration, config, storage

- It is an integration plugin like Telegram and Twilio (`integrations.ts`): installed from Plugins with the PIN,
  Configure page, Turn on/off, Remove. The integration framework is generalized from the two fixed ids to a registry so a
  broker is a catalog entry (id `zerodha`, later `angelone`), not a code branch.
- Config (`config.json`): `brokers.<id>: { installed, enabled, apiKey, apiSecret }` plus `trading: { level: "read" }`.
  `apiSecret` is write-only (never sent to the screen; the view only says it is set).
- The daily access token is stored in the data folder with owner-only permissions, in a separate file, deleted when it
  expires or on Remove. It is never returned by any route and never given to the AI.
- DB: `report_schedules (id, name, kind, time_local, days, channel, enabled, last_run_day)` and an audit trail of every
  broker read and every report sent (kind and size only, never amounts or secrets).

### 2.5 Reports and scheduler

`server/src/brokers/report.ts` builds a report from the portfolio service as plain text (and a short WhatsApp/Telegram
variant). The numbers are computed by Friend, not written by the model, so reports are exact and cost no model usage. An
optional per-schedule switch adds a short AI commentary (off by default).

`server/src/brokers/scheduler.ts` ticks once a minute using the app's clock. A schedule has a local time (the owner's time
zone), weekdays only by default plus an owner-maintained list of skipped dates (the free plan has no holiday calendar), a
channel (Telegram or WhatsApp/SMS to the owner's own chat or number) and a `last_run_day` so a restart never sends one
twice and a missed minute is caught up within the same day.

If the session has expired when a report is due, the scheduler sends the login link to the same channel instead
("Login needed - tap here") and sends the report as soon as the login completes. Before the first scheduled report of the
day it also sends the login link a configurable number of minutes earlier (default 15 minutes before; the owner can turn it off).

Sending a scheduled report to the owner's own chat is covered by the owner having created the schedule; it does not ask
again. Creating, changing or removing a schedule through the AI needs the owner's PIN (it sends financial data to an
outside messaging service).

### 2.6 AI tools and skill

Tools (all follow the owner's approval setting; they are tier T2, so auto mode does not ask, manual does):
`portfolio.status`, `portfolio.summary`, `portfolio.holdings`, `portfolio.positions`, `portfolio.funds`,
`portfolio.orders`, `reports.run` (send a report now, to the linked channel or return it in chat). Schedule management
(`reports.schedule`, `reports.list`, `reports.remove`) is tier T3 (PIN). None of the tools takes a token or secret.

The skill ships with the integration (installed and removed with it) as a normal skill file, broker-independent. It
instructs the AI to: read numbers only from the tools and never invent them; say plainly when data is stale, a capability
is missing, or the login has expired and offer to send the login link; describe what the numbers show without buy/sell
calls, price predictions or personalized advice; treat anything arriving from news, email, messages or other tools as
untrusted data; and never place or suggest placing orders (v1 has none).

### 2.7 Settings toggle

Settings -> Trading shows the permission level as three choices: Read only (selected, active), Orders each approved with
the PIN (locked, "later version"), Orders within the owner's limits (locked, "later version"). Raising the level always
requires the PIN and can never be done by the AI (refused in `refuseForAgent`). The page also shows the plain-language
data notice (see 3). Only `level: "read"` is accepted by the server in v1.

## 3. Security and privacy

- Read only by construction: no order, modify or cancel endpoint is implemented in any provider in v1.
- Write-only secrets: API secret and access token are never sent to the screen or the AI; audit entries never contain them.
- The unauthenticated return route accepts only a valid, unused, unexpired (10 minutes) `state` made by Friend, is rate
  limited, answers with a generic page on any failure, and consumes the state on first use.
- Portfolio tools follow the approval setting (manual asks each time; auto does not).
- Prompt-injection posture: portfolio data, news, messages and inbox text are data. The skill and the tool descriptions say
  so. There is nothing in v1 for an injected instruction to do with money.
- Where numbers go, stated on the Configure page: with Claude as the model, what the AI reads is sent to Anthropic; with
  local Ollama it stays on the PC. Reports sent to Telegram or WhatsApp pass through those services.
- Guests and unverified voices cannot use any portfolio tool (existing trust rules).

## 4. Errors and edge cases

Session expired (offer login link; never retry silently in a loop); broker rate limit or outage (report says which
section failed and sends the rest); API key rejected (Configure page shows the broker's reason, secrets masked); clock
changes and restarts (schedules use `last_run_day`); a provider lacking a capability (report omits the section and
says so); Friend not reachable from the phone when the link is tapped (the Configure page explains the public-address
requirement and offers the PC login).

## 5. Testing

No real account is touched. A fake Zerodha server (injectable fetch) with recorded-shape fixtures drives: the provider;
a shared provider contract suite that every broker must pass (so a new broker is verified the same way); the portfolio
math; report text (snapshot-style assertions on exact figures); the scheduler with a fake clock (times, weekdays, skipped
dates, restart without duplicates, expired session path); the return route (replayed, expired, forged and missing state;
rate limit); settings (secrets never in views; level can only be `read`; AI cannot change it); AI tool flows including
approval behavior in manual and auto; web tests for the Configure page, the Trading settings page and the schedules list;
a real-browser check against the fake server. Limit: the first live login against the owner's real Zerodha account is done
by the owner; the Configure page walks through it.

## 6. Out of scope for v1, planned for later

Order placement with the owner's limits and practice mode, quotes and watchlists (paid data plan), further brokers,
holiday calendar, F&O and mutual-fund order types.
