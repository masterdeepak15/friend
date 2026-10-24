"""One intraday trade, worked out exactly. Arguments arrive as JSON in /work/args.json; the answer is printed."""

import json
import math
import sys

a = json.load(open("/work/args.json"))


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(2)


side = str(a.get("side", "")).lower()
if side not in ("buy", "sell"):
    fail("side must be buy or sell.")
entry, stop = float(a["entry"]), float(a["stop"])
mult, max_loss, capital = float(a["reward_multiple"]), float(a["max_loss"]), float(a["capital"])
leverage = max(1.0, float(a.get("leverage") or 1))
min_mult = float(a.get("min_reward_multiple") or 0)
tick = float(a.get("tick") or 0.05)

if min(entry, stop, mult, max_loss, capital) <= 0:
    fail("Entry, stop, reward multiple, max loss and capital must be above zero.")
risk = entry - stop if side == "buy" else stop - entry
if risk <= 0:
    fail("The stop must be below the entry for a buy and above it for a sell.")


def snap(p):
    return round(round(p / tick) * tick, 2)


target = snap(entry + risk * mult if side == "buy" else entry - risk * mult)
qty_by_loss = math.floor(max_loss / risk)
qty_by_cash = math.floor(capital * leverage / entry)
qty = max(0, min(qty_by_loss, qty_by_cash))
used = qty * entry
problems = []
if qty == 0:
    problems.append("Not even one share fits the max loss and the money available.")
if qty and qty == qty_by_cash and qty_by_cash < qty_by_loss:
    problems.append("Money, not the max loss, limits the size.")
if min_mult and mult < min_mult:
    problems.append(f"Reward to risk {mult:g} is below the owner's minimum {min_mult:g}.")
print(json.dumps({
    "side": side, "entry": entry, "stop": snap(stop), "target": target, "risk_per_share": round(risk, 2),
    "quantity": qty, "capital_used": round(used, 2), "margin_needed": round(used / leverage, 2),
    "loss_at_stop": round(qty * risk, 2), "gain_at_target": round(qty * abs(target - entry), 2),
    "reward_to_risk": mult, "problems": problems, "ok": not problems,
}, indent=2))
