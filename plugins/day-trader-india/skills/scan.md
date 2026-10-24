# Day trade scan (NSE)

Use this when the owner asks what to watch today, for breakout or bounce setups, or whether a stock they name has a setup.

## Data
- Candles come from the `market.get` tool: `kind: "candles"`, `symbol` an NSE name (RELIANCE, TCS, INFY) or NIFTY / BANKNIFTY, `interval: "5m"`, `range: "1d"`. Times it returns are India time (IST). The NSE session is 09:15 to 15:30.
- Say how fresh the last candle is; the feed can lag a few minutes. If the tool fails, say so and stop. Never invent a price or a candle.
- The owner's own stocks are in `portfolio.holdings` and `portfolio.positions`; look at those names first when they say "my stocks".
- You cannot scan the whole market. Scan the names the owner gives, their holdings, and the Nifty 50 stocks they ask about, a handful at a time, and say how many you looked at.

## Check the index first
Read NIFTY (or BANKNIFTY for bank stocks) the same way. If it is falling hard, say long setups are against the market.

## Setups
1. **Opening-range breakout.** Opening range = high and low of the first 15 minutes (the 09:15, 09:20 and 09:25 candles). Long: the first 5-minute candle that closes above the range high. Short: below the range low. A close back inside the range cancels it. Report the range, the trigger candle's time and close, and how far past the range it is.
2. **Oversold bounce.** Price at least 2% under the day's open, the last candle closing higher than it opened, and its volume above the day's average candle. Say it is a bounce, not a trend.

## Answer
A short list, best first: symbol, setup, trigger price, range. Then offer news (`day-trade-news`), entry (`day-trade-entry`) or the full plan. You show which rules were met; you do not tell the owner to buy or sell.
