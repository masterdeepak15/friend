# Day trade replay

Use this after a plan exists and before the owner risks money, or when they ask "what are the odds".

## How
Call `market.replay` with `symbol`, `side` (buy or sell), and the plan's `stop` and `target` prices. Leave `runs` and `seed` out unless the owner wants them; the same seed repeats the same answer. It fetches the last 60 days of 5-minute candles itself and plays the rest of today from the latest candle.

## Say it plainly
- Simulated: the share of runs where the target came first, the stop first, and neither by the close.
- Real past days: the same stop and target over the real rest of each past session from this time of day, and how many days that was.
- "Reshuffled past moves, not a forecast", once.
- Target first and stop first close together is a coin flip; say that. A stop that comes first more often than the target is worth saying out loud.
- Fewer than about 20 past days: the result is thin, say so.
- A result is not a promise and not advice to take or skip the trade.

It works best when the market is open and a few candles of today exist. If the tool says there are too few candles, say it is too early in the session or the stock is thinly traded.
