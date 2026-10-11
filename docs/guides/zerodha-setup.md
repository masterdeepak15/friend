# Zerodha portfolio: setup guide

Friend can read your Zerodha account and tell you how your portfolio is doing, on the screen, by voice, or as a report on Telegram or WhatsApp at the times you choose. This version is **read only**: Friend cannot place, change or cancel any order.

## What it does and does not do

| Does | Does not |
|---|---|
| Reads holdings, positions, funds and today's orders | Place, change or cancel orders (not in this version) |
| Works out value, profit and loss, today's change, biggest movers, concentration | Tell you what to buy or sell, or predict prices (it is not a licensed adviser) |
| Sends a morning report and a market-close report to your phone on the days you choose | Show live prices for stocks you do not hold (that is Zerodha's paid data plan) |
| Reminds you to log in before the first report of the day | Log in for you: you sign in on Zerodha's own page, so your Zerodha password and 2FA never reach Friend |

## Cost

Friend itself adds no cost and uses no third-party service: it talks directly to Zerodha from your PC.

Zerodha offers a free **Personal** API plan (order and portfolio management) and a paid **Connect** plan (₹500 per month at the time of writing) that adds live streaming and historical data. Friend's read-only portfolio features use only what the free plan includes. Check the current plans at <https://zerodha.com/products/api/> before you start: prices and plans are Zerodha's to change.

## 1. Create a Kite Connect app

1. Sign in at <https://developers.kite.trade> with your Zerodha account.
2. Create an app (choose the free Personal type if offered).
3. Set its **Redirect URL** to the address shown on Friend's Zerodha Configure page (step 3 below). It looks like `https://your-address/api/brokers/zerodha/callback`.
4. Copy the app's **API key** and **API secret**. Treat the secret like a password.

The redirect URL must be an address your phone or browser can reach. If you only use Friend on the PC that runs it, `http://127.0.0.1:8787/api/brokers/zerodha/callback` also works. For logging in from your phone you need Friend's public address (see "Using your own domain later" in the README: `friend config set publicUrl https://…`).

## 2. Install the plugin

Esc, then **Plugins**. Under *Available*, find **Zerodha** and press **Install** (PIN). Installing also adds a short *Portfolio assistant* skill, so Friend knows how to talk about your portfolio (figures only from the tools, no advice).

## 3. Configure it

Press **Configure** on Zerodha.

1. The page shows the **redirect URL** to register in your Kite app (step 1.3).
2. Paste the **API key** and the **API secret**, then **Save…** (PIN). The secret is write-only: once saved it is never shown again, only "A secret is saved".
3. Back in the plugins list, press **Turn on** (PIN).

Also on this page:

- **Time zone** (default Asia/Kolkata), used for report times.
- **Days with no reports**: market holidays or your own days off, one date per line (`2026-11-08`).
- **Remind me to log in**: minutes before the first report of the day (default 15, 0 turns the reminder off).

## 4. The first live login

Zerodha ends every login at about 6 am the next morning, so you do this **once a day** (Friend reminds you before the first report).

1. Press **Open Zerodha login**. Zerodha's own page opens in a new tab.
2. Sign in with your Zerodha user ID, password and 2FA, and approve the permission for your app.
3. Zerodha sends you back to Friend and a small page says **Logged in. You can close this tab.**
4. The Configure page now says the login is active, and **Show a report now** returns your portfolio.

If you are not at the PC, press **Send me the login link on Telegram** (or WhatsApp): the link arrives on your phone, you sign in there, and any report that was waiting is sent right after.

The first time, if something does not work, see the troubleshooting table below. Friend never sees your Zerodha password; it only receives a one-time code from Zerodha, which it exchanges for the day's access token.

## Report options

On the Configure page, **Report options** lets you change how reports and answers are written, so Friend is not tied to one country or broker:

| Setting | Default | Range |
|---|---|---|
| Currency sign | ₹ | up to 4 characters |
| Currency word (spoken by Alexa) | rupees | up to 20 characters |
| Number format (locale) | en-IN (1,23,456.50) | any locale such as en-US (123,456.50) or de-DE (123.456,50) |
| Mention a holding above this share of the portfolio | 30% | 5 to 90 |
| Mention a holding down more than this today | 5% | 1 to 50 |
| Seconds to keep an account read (protects the broker's rate limit) | 30 | 5 to 300 |
| Most report schedules | 20 | 1 to 50 |
| Tries a day for a report | 3 | 1 to 10 |

## 5. Reports

Use **Add a report** on the Configure page (name, morning/close/custom, time like 09:30, days, Telegram/WhatsApp/SMS; PIN), or just ask in chat:

- "Send me a portfolio report at 9:30 and 3:45 on weekdays on Telegram."
- "How is my portfolio doing?"
- "What are my positions?"
- "Send me a report now."

Every number in a report is worked out by Friend from your account, never written by the AI model. The schedule is saved, so a restart never sends a report twice, and a report missed while Friend was off is sent when it is back (same day only). If the login has ended when a report is due, you get the login link instead of figures, and the report follows once you sign in.

## Privacy

- Your Zerodha password, 2FA and the day's access token are never sent anywhere except Zerodha. The API secret and token are write-only and kept on this PC (the token in a file only you can read).
- When you ask Friend about your portfolio, the figures pass through the AI model you chose in Settings (Claude from Anthropic, or Ollama on this PC if you chose that). A scheduled report is sent to the messaging app you pick (Telegram or WhatsApp). Nothing else leaves your PC.
- Friend records that a report was made (its kind and size) but never the amounts.
- The assistant can never change the broker settings or the trading level, even with your PIN. Settings → **Trading** shows *Read only*; the order levels are shown as "later version" and cannot be chosen.

## Troubleshooting

| You see | Why | What to do |
|---|---|---|
| "Login needed" | Zerodha's daily login ended (about 6 am) | Press **Open Zerodha login**, or send yourself the link from the Configure page |
| "That did not work. Start again from Friend." after Zerodha | The login link was used already, is older than 10 minutes, or the redirect URL differs | Press **Open Zerodha login** again; check the redirect URL in your Kite app matches the one on the Configure page exactly |
| "Not available (rate limit)" on a line of a report | Zerodha limits requests | Wait a minute and ask again; the rest of the report still arrives |
| "Not available (login expired)" | The login ended while the report was being made | Log in again |
| Zerodha rejects the key or secret | A typo, or the app was deleted | Paste them again on the Configure page (the secret field is empty; type the full secret) |
| "No public address is set" | Friend has no `publicUrl`, so your phone cannot be sent back to it | `friend config set publicUrl https://your-address`, or log in from the PC itself |
| No report arrived | The report channel is off, or the login ended | Check Telegram/WhatsApp is switched on in Plugins; check the login; look in the Configure page for the schedule's "last sent" day |

## Adding another broker later

A broker is one file that implements Friend's `BrokerProvider` contract (login flow, holdings, positions, funds, orders, capabilities) and passes the shared contract test suite (`runBrokerContract`). Reports, tools, the skill and the screens only see the contract, so a new broker (Angel One, Upstox and so on) does not change them.
