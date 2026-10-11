/** How money is written: the currency sign and the number format (grouping and decimal marks) of a locale. */
export interface MoneyOptions {
  symbol: string;
  /** A BCP 47 locale such as en-IN (1,23,456.50), en-US (123,456.50) or de-DE (123.456,50). */
  locale: string;
}

export const DEFAULT_MONEY: MoneyOptions = { symbol: "₹", locale: "en-IN" };

const formats = new Map<string, Intl.NumberFormat>();
function formatterFor(locale: string): Intl.NumberFormat {
  let f = formats.get(locale);
  if (!f) {
    try {
      f = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2, useGrouping: true });
    } catch {
      f = formatterFor(DEFAULT_MONEY.locale);
    }
    formats.set(locale, f);
  }
  return f;
}

/** "₹1,23,456.50" by default. Never "-₹0.00", never NaN; a locale that does not exist falls back to the default one. */
export function formatMoney(n: number, o: MoneyOptions = DEFAULT_MONEY): string {
  const value = Number.isFinite(n) ? n : 0;
  const fixed = Math.abs(value).toFixed(2);
  const negative = value < 0 && fixed !== "0.00";
  return `${negative ? "-" : ""}${o.symbol}${formatterFor(o.locale).format(Number(fixed))}`;
}
