# Day trade exit (NSE)

Use this to set the way out of a day trade before the owner goes in.

## Stop
The other side of the setup. Breakout: the middle of the opening range (or its far edge if the owner wants a wider stop). Bounce: under the low of the bounce candle. Say the risk per share (entry minus stop).

## Target
A multiple of the risk. Use the owner's multiple; if they have none, offer 1 and 1.5 and say the odds fall as the target grows (check with `day-trade-replay`).

## Square-off time
Brokers close intraday (MIS) positions automatically near the end of the day, often between 15:15 and 15:25 IST, and charge for it. Ask the owner their broker's cut-off; do not assume it.

## Reminders
`task.add` can remind the owner at a time (for example "Square off TCS" at 15:10 IST today, with `dueAt` carrying the +05:30 offset). A reminder only notifies; it does not watch the price or run anything. Say that plainly. Price alerts need the broker's own app (GTT or alerts).

## Say it all in one line
"Stop 1,180, target 1,205, out by 15:15." Then offer `day-trade-budget` for the size.
