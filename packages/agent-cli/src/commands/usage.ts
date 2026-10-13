import { openDb, UsageLog, type UsageSummary } from "@friend/server";
import type { IO } from "../cli";

const USAGE = "Usage: friend usage [--days N] | friend usage clear";

/** What the command needs; tests replace it. */
export interface UsageLike {
  summary(days: number): UsageSummary;
  clear(): number;
}

const n = (v: number) => v.toLocaleString("en-US");
const row = (label: string, input: number, output: number, turns: number, width: number) => `${label.padEnd(width)}  ${n(input).padStart(12)}  ${n(output).padStart(12)}  ${String(turns).padStart(6)}`;

/** `friend usage`: the tokens Friend used, day by day. Counts only, never what was said. */
export async function usageCommand(args: string[], io: IO, log?: UsageLike): Promise<number> {
  let days = 7;
  let clear = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "clear") clear = true;
    else if (a === "--days" && /^\d+$/.test(args[i + 1] ?? "")) days = Number(args[++i]);
    else {
      io.err(USAGE);
      return 1;
    }
  }
  const db = log ? null : openDb(io.dataDir);
  try {
    const l = log ?? new UsageLog(db!);
    if (clear) {
      io.out(`Removed ${l.clear()} saved counts.`);
      return 0;
    }
    const s = l.summary(days);
    if (s.total.turns === 0) {
      io.out(`Nothing used in the last ${s.range} days.`);
      io.out("Friend keeps counts only (no words), once a model has answered.");
      return 0;
    }
    io.out(`Tokens used in the last ${s.range} days`);
    io.out("");
    io.out(`${"Day".padEnd(10)}  ${"Input".padStart(12)}  ${"Output".padStart(12)}  ${"Turns".padStart(6)}`);
    for (const d of s.days) io.out(row(d.day, d.input, d.output, d.turns, 10));
    io.out(row("Total", s.total.input, s.total.output, s.total.turns, 10));
    io.out("");
    io.out("By model");
    for (const m of s.byModel) io.out(row(`${m.provider} / ${m.model}`, m.input, m.output, m.turns, 28));
    io.out("");
    io.out("By where it came from");
    for (const m of s.bySource) io.out(row(m.source, m.input, m.output, m.turns, 28));
    io.out("");
    io.out("Friend keeps counts only (no words). Remove them with: friend usage clear");
    return 0;
  } finally {
    db?.close();
  }
}
