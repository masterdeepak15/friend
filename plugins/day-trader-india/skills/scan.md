# Day trade scan (NSE)

Use this when the owner asks what is breaking out, for breakout or bounce setups, or whether a stock they name has a setup. For "what should I trade today" use `day-trade-focus`, which includes this.

## Tools
- `market.scan` does the scan: with no symbols it looks at what is trading hardest today (most active, volume spurts, biggest F&O movers, about 28 stocks); with `symbols` it scans the owner's list (up to 28). It returns the setups ranked, with entry, stop and target. Say how many stocks it looked at.
- `market.get` with `kind: "candles"` (symbol, `interval: "5m"`, `range: "1d"`) shows one stock's candles; `movers`, `active` and `volume` show the raw market lists. NIFTY and BANKNIFTY work as symbols for the index.
- The owner's own stocks are in `portfolio.holdings` and `portfolio.positions`: use them as `symbols` when they say "my stocks".
- Times are India time (IST); the session is 09:15 to 15:30. If a tool fails, say so. Never invent a price or a candle.

## The setups (what the scan checks)
1. **Opening-range breakout**: the first 5-minute close above the high (or below the low) of the first 15 minutes. A close back inside the range cancels it. "Near" means it is close to triggering.
2. **Oversold bounce**: price at least 2% under the open, the last candle green, volume above the day's average.
Entry is the trigger close, the stop the middle of the opening range (bounce: under the bounce candle), the target 1.5 times the risk. "LATE" means it already ran far past the trigger or triggered after 14:30: do not chase it.

## Answer
The setups, best first, in the scan's words, plus the market view (is NIFTY with it or against it). Offer the news check, the odds (`day-trade-replay`) and the size. These are the setups the rules flag; the owner decides.
