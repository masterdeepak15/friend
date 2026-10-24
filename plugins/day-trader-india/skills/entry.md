# Day trade entry (NSE)

Use this when the owner has a setup in mind and asks "is it time", "has it triggered" or "should I wait".

## How
1. Read the 5-minute candles for the stock with `market.get` (`candles`, `5m`, `1d`). The last candle may still be forming: a candle that has not finished does not count. A candle starting at 10:10 finishes at 10:15.
2. Apply the setup's rule from `day-trade-scan`. Answer with one of three words and the reason:
   - **waiting**: what has to happen (for example "needs a close above 1,204.50; the last finished candle closed 1,201.10").
   - **triggered**: which candle, its time and close. The entry price is that close.
   - **cancelled**: for example the price closed back inside the opening range.
3. Skip it, and say why, when: the trigger comes after 14:30 IST, the news is exposed to an event today (`day-trade-news`), the index is against the direction, or the move is already more than about one range-width past the trigger (chasing).

## What you must not do
You cannot place an order and you do not tell the owner to. Give the facts; the owner decides and places it in their broker app.
