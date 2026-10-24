"""Replays the rest of a session from past days' moves at the same time of day. Arguments arrive as JSON in /work/args.json."""

import json
import random
import sys

a = json.load(open("/work/args.json"))


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(2)


side = str(a.get("side", "")).lower()
if side not in ("buy", "sell"):
    fail("side must be buy or sell.")
parse = lambda s: [float(x) for x in str(s).replace(";", ",").replace("\n", ",").split(",") if x.strip()]
today = parse(a["today"])
days = [parse(line) for line in str(a["days"]).splitlines() if line.strip()]
days = [d for d in days if len(d) > len(today)]
stop, target = float(a["stop"]), float(a["target"])
runs = max(100, min(50000, int(a.get("runs") or 10000)))
if not today or len(days) < 5:
    fail("Need today's candles so far and at least 5 past days that are longer than today so far.")
long_ = side == "buy"


def outcome(path):
    for p in path:
        hit_t = p >= target if long_ else p <= target
        hit_s = p <= stop if long_ else p >= stop
        if hit_s:
            return "stop"
        if hit_t:
            return "target"
    return "open"


# the move from one candle to the next, per time of day, as a ratio
moves = [[d[i + 1] / d[i] for d in days if i + 1 < len(d)] for i in range(len(today) - 1, max(len(d) for d in days) - 1)]
rng = random.Random(int(a.get("seed") or 1))
count = {"target": 0, "stop": 0, "open": 0}
for _ in range(runs):
    p, path = today[-1], []
    for slot in moves:
        p *= rng.choice(slot)
        path.append(p)
    count[outcome(path)] += 1

# the same rule on the real past days, from the same time of day
real = {"target": 0, "stop": 0, "open": 0}
for d in days:
    scale = today[-1] / d[len(today) - 1]
    real[outcome([x * scale for x in d[len(today):]])] += 1
pct = lambda c: {k: round(100 * v / sum(c.values()), 1) for k, v in c.items()}
print(json.dumps({"simulated_percent": pct(count), "real_past_days": real, "past_days_used": len(days), "runs": runs, "seed": int(a.get("seed") or 1)}, indent=2))
