import { DEFAULT_MONEY, formatMoney, type MoneyOptions } from "./money";
import { summarize, type PortfolioSnapshot, type Section } from "./portfolio";
import type { Capabilities, Holding } from "./types";

export type ReportKind = "morning" | "close" | "custom";

/** Rupees with Indian grouping (₹1,23,45,678.90): the default way money is written. See money.ts for the owner's own symbol and locale. */
export const formatInr = (n: number): string => formatMoney(n);

const signedMoney = (n: number, m: MoneyOptions): string => (n > 0.004 ? `+${formatMoney(n, m)}` : formatMoney(n, m));
const signedPct = (p: number): string => {
  const x = Number.isFinite(p) ? p : 0;
  const text = Math.abs(x).toFixed(2);
  return text === "0.00" ? "0.00%" : `${x > 0 ? "+" : "-"}${text}%`;
};
const pct1 = (p: number): string => Math.abs(p).toFixed(1);

const TITLE: Record<ReportKind, string> = { morning: "Morning report", close: "Market close report", custom: "Portfolio report" };

/** Why a part could not be read, in words a person can use. */
const WHY: Record<string, string> = { rate: "rate limit", session: "login expired", network: "network problem", auth: "login problem" };
const missing = (label: string, s: Extract<Section<unknown>, { ok: false }>): string => `${label}: not available (${WHY[s.kind] ?? s.error.slice(0, 60)})`;

/** What the report is told by the owner's settings. Defaults are the original behaviour. */
export interface ReportOptions {
  money: MoneyOptions;
  /** A holding that is more than this share (percent) of the portfolio is mentioned. */
  concentrationPct: number;
  /** A holding down more than this (percent) today is mentioned. */
  bigDropPct: number;
}
export const DEFAULT_REPORT_OPTIONS: ReportOptions = { money: DEFAULT_MONEY, concentrationPct: 30, bigDropPct: 5 };

function title(kind: ReportKind, broker: string, now: Date, zone: string): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-GB", { timeZone: zone, weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(now)
      .map((p) => [p.type, p.value]),
  );
  return `${TITLE[kind]} - ${broker} - ${parts.weekday} ${parts.day} ${parts.month}, ${parts.hour}:${parts.minute}`;
}

export interface ReportInput {
  snapshot: PortfolioSnapshot;
  kind: ReportKind;
  caps: Capabilities;
  now: Date;
  broker: string;
  /** The owner's time zone for the title. */
  zone?: string;
  options?: ReportOptions;
}

const dayMovePct = (h: Holding): number => (h.closePrice > 0 ? ((h.lastPrice - h.closePrice) / h.closePrice) * 100 : 0);

/**
 * The plain-text report. Every number is computed here from the account, never written by a model, and the words describe
 * what the numbers show: nothing in it tells anyone what to buy or sell.
 */
export function buildReport(input: ReportInput): string {
  const { snapshot: snap, caps } = input;
  const o = input.options ?? DEFAULT_REPORT_OPTIONS;
  const fmt = (n: number) => formatMoney(n, o.money);
  const signed = (n: number) => signedMoney(n, o.money);
  const out: string[] = [title(input.kind, input.broker, input.now, input.zone ?? "Asia/Kolkata"), ""];

  if (caps.holdings) {
    if (!snap.holdings.ok) out.push(missing("Holdings", snap.holdings));
    else if (snap.holdings.data.length === 0) out.push("No holdings.");
    else {
      const holdings = snap.holdings.data;
      const s = summarize(holdings);
      out.push(`Portfolio: ${fmt(s.value)} (invested ${fmt(s.invested)})`);
      out.push(`Profit/loss: ${signed(s.pnl)} (${signedPct(s.pnlPct)})`);
      out.push(`Today: ${signed(s.dayChange)} (${signedPct(s.dayChangePct)})`);
      const mover = (h: Holding) => `- ${h.symbol} ${signed(h.quantity * (h.lastPrice - h.closePrice))} (${signedPct(dayMovePct(h))})`;
      if (s.gainers.length) out.push("", "Up today:", ...s.gainers.map(mover));
      if (s.losers.length) out.push("", "Down today:", ...s.losers.map(mover));

      const flags: string[] = [];
      const top = s.top[0];
      if (top && s.topHoldingPct > o.concentrationPct) flags.push(`- ${top.symbol} is ${pct1(s.topHoldingPct)}% of the portfolio.`);
      for (const h of holdings) if (dayMovePct(h) < -o.bigDropPct) flags.push(`- ${h.symbol} is down ${pct1(dayMovePct(h))}% today.`);
      if (flags.length) out.push("", "Worth a look:", ...flags);
    }
  }

  if (caps.positions) {
    out.push("");
    if (!snap.positions.ok) out.push(missing("Positions", snap.positions));
    else {
      const open = snap.positions.data.filter((p) => p.quantity !== 0);
      if (open.length === 0) out.push("No open positions.");
      else {
        out.push("Open positions:");
        for (const p of open) out.push(`- ${p.symbol} ${p.product} ${p.quantity}${p.quantity < 0 ? " (short)" : ""} @ ${fmt(p.avgPrice)}, P&L ${signed(p.pnl)}`);
      }
    }
  }

  if (caps.funds) {
    out.push("");
    if (!snap.funds.ok) out.push(missing("Funds", snap.funds));
    else out.push(`Funds: ${fmt(snap.funds.data.available)} available, ${fmt(snap.funds.data.used)} used`);
  }

  if (caps.orders && snap.orders.ok && snap.orders.data.length > 0) out.push(`Orders today: ${snap.orders.data.length}`);

  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}
