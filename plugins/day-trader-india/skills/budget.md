# Day trade budget (NSE)

Use this to size a trade from what the owner can afford to lose.

## First ask, once, and remember for the session
Their **max loss per trade** (rupees), the **money for this trade**, their **intraday leverage** (1 if none), and their **minimum reward to risk**. These are theirs to set. Never assume them and never suggest more than they gave.

## The numbers
Call the `trade-plan` tool with side, entry, stop, reward_multiple, max_loss, capital, leverage and min_reward_multiple. Do not do the arithmetic yourself. It returns the quantity, the target, the capital and margin used, the loss at the stop, the gain at the target, and any problems. Quote its figures exactly. If `ok` is false, show the problems and do not present the plan as ready.

## Charges
Brokerage, STT, exchange charges and GST are real and can eat a small target. Say the figures are before charges.

## Next
Offer `day-trade-risk` to check the plan against the owner's limits.
