# Day trade risk (NSE)

Use this to check a finished plan against the owner's limits and say PASS or BLOCK, with the reason.

## Their limits (ask once; they are the owner's, never yours)
Max loss per trade, daily loss limit, number of trades they allow today, minimum reward to risk, latest time to enter, and the most money in one trade.

## Check, in this order
1. The `trade-plan` result is `ok` (loss at the stop within the max loss, size within the money, reward to risk at or above the minimum).
2. Loss already taken today plus this trade's loss at the stop does not pass the daily limit. Take today's trades from the owner, or from `portfolio.orders` and `portfolio.positions` when they are connected; if you cannot tell, ask.
3. Trades so far today is below the limit.
4. The entry time is not past their latest time.
5. The stop is set. A plan with no stop is a BLOCK.

## Answer
**PASS** or **BLOCK**, then each check on its own line with the figure. A BLOCK names the one thing to change. Never argue the owner out of their own limits and never suggest raising them. If the daily loss limit is reached, say the day is done.

You cannot place orders. When the plan passes, say the owner places it in their broker app.
