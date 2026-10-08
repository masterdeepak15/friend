"""Converts a value between units. Arguments arrive as JSON in /work/args.json; the answer is printed."""

import json
import sys

args = json.load(open("/work/args.json"))
value, src, dst = args["value"], str(args["from"]).strip().lower(), str(args["to"]).strip().lower()

# every table maps a unit to its size in the base unit (metre, kilogram, litre)
TABLES = {
    "length": {"mm": 0.001, "cm": 0.01, "m": 1.0, "km": 1000.0, "in": 0.0254, "ft": 0.3048, "yd": 0.9144, "mi": 1609.344},
    "mass": {"mg": 1e-6, "g": 0.001, "kg": 1.0, "oz": 0.028349523125, "lb": 0.45359237},
    "volume": {"ml": 0.001, "l": 1.0, "cup": 0.2365882365, "qt": 0.946352946, "gal": 3.785411784},
}
TEMPERATURE = {"c", "f", "k"}


def fail(message):
    print(message, file=sys.stderr)
    sys.exit(2)


def temperature(v, a, b):
    kelvin = {"c": v + 273.15, "f": (v - 32) * 5 / 9 + 273.15, "k": v}[a]
    if kelvin < 0:
        fail("That is below absolute zero.")
    return {"c": kelvin - 273.15, "f": (kelvin - 273.15) * 9 / 5 + 32, "k": kelvin}[b]


if src in TEMPERATURE and dst in TEMPERATURE:
    result = temperature(value, src, dst)
else:
    for table in TABLES.values():
        if src in table and dst in table:
            result = value * table[src] / table[dst]
            break
    else:
        fail(f"I cannot convert {src} to {dst}. Units must be of the same kind (length, mass, volume or temperature).")

print(f"{value:g} {src} = {result:.6g} {dst}")
