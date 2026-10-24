# Day trade replay

Use this after a plan exists and before the owner risks money, or when they ask "what are the odds".

## Steps
1. Read the stock's last 20 to 59 sessions of 5-minute candles with `web.read` (`https://query1.finance.yahoo.com/v8/finance/chart/SYMBOL.NS?interval=5m&range=60d`; Yahoo keeps about 60 days of 5-minute bars). Group the closes by session date in IST, oldest first, regular hours only (09:15 to 15:30).
2. Take today's closes so far from the open.
3. Call the `replay` tool with `days` (one session per line, closes separated by commas), `today` (commas), `side`, the plan's `stop` and `target`. Use the default seed unless the owner wants another; the same seed repeats the result.
4. Report in plain words: the share of simulated sessions where the target came first, the stop first, and neither (still open at the close), then the same counts on the real past days, and how many past days were used.

## How to speak about it
- It is the stock's own past moves reshuffled, not a forecast. Say so once.
- Target first and stop first near each other means close to a coin flip; say that plainly. A plan whose stop comes first more often than its target is worth saying out loud.
- With fewer than about 20 past days, say the result is thin.
- Never present a percentage as a promise, and never tell the owner to take or skip the trade; they decide.
