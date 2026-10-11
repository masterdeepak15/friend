import type { PortfolioSnapshot, Section } from "./portfolio";
import { DEFAULT_MONEY, formatMoney, type MoneyOptions } from "./money";

export type PartName = "holdings" | "positions" | "funds" | "orders";

const MAX_ROWS = 40;
const WHY: Record<string, string> = { rate: "Zerodha's rate limit was hit, try again in a minute", session: "the login has ended", network: "Zerodha could not be reached", auth: "there is a login problem" };

const asOf = (at: number, zone: string): string =>
  new Intl.DateTimeFormat("en-GB", { timeZone: zone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(new Date(at));

const rows = <T>(items: T[], line: (x: T) => string): string[] => [...items.slice(0, MAX_ROWS).map(line), ...(items.length > MAX_ROWS ? [`...and ${items.length - MAX_ROWS} more`] : [])];

/** One part of the account as plain text for the model: every number is the broker's, none is made up. Money is rupees. */
export function partText(part: PartName, snap: PortfolioSnapshot, zone: string, money: MoneyOptions = DEFAULT_MONEY): string {
  const formatInr = (n: number) => formatMoney(n, money);
  const section = snap[part] as Section<unknown>;
  if (!section.ok) return `Could not read the ${part}: ${WHY[section.kind] ?? section.error.slice(0, 100)}.`;
  const head = `Zerodha ${part} as of ${asOf(snap.at, zone)}:`;
  switch (part) {
    case "holdings": {
      const h = (snap.holdings as Extract<typeof snap.holdings, { ok: true }>).data;
      if (!h.length) return `${head} none.`;
      return [head, ...rows(h, (x) => `- ${x.symbol} (${x.exchange}) x${x.quantity}, avg ${formatInr(x.avgPrice)}, last ${formatInr(x.lastPrice)}, P&L ${formatInr(x.pnl)}, today ${x.dayChangePct.toFixed(2)}%`)].join("\n");
    }
    case "positions": {
      const p = (snap.positions as Extract<typeof snap.positions, { ok: true }>).data;
      if (!p.length) return `${head} none open.`;
      return [head, ...rows(p, (x) => `- ${x.symbol} (${x.exchange}, ${x.product}) x${x.quantity}${x.quantity < 0 ? " (short)" : ""}, avg ${formatInr(x.avgPrice)}, last ${formatInr(x.lastPrice)}, P&L ${formatInr(x.pnl)}`)].join("\n");
    }
    case "funds": {
      const f = (snap.funds as Extract<typeof snap.funds, { ok: true }>).data;
      return `${head}\nAvailable ${formatInr(f.available)}, used ${formatInr(f.used)}, total ${formatInr(f.total)}.`;
    }
    case "orders": {
      const o = (snap.orders as Extract<typeof snap.orders, { ok: true }>).data;
      if (!o.length) return `${head} no orders today.`;
      return [head, ...rows(o, (x) => `- #${x.id} ${x.side} ${x.symbol} x${x.quantity} ${x.type} ${x.status}${x.price ? ` @ ${formatInr(x.price)}` : ""} (${x.at})`)].join("\n");
    }
  }
}
