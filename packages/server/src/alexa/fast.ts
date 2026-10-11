import type { PortfolioSummary } from "../brokers/portfolio";
import { DEFAULT_MONEY, formatMoney, type MoneyOptions } from "../brokers/money";
import type { TaskRow } from "../tasks";
import type { Lang } from "./phrases";

/** What the owner's settings say about money: the number format and the word spoken for the currency. */
export interface SpeechMoney {
  money?: MoneyOptions;
  currencyName?: string;
}

/** "1,23,456.50 rupees": the owner's number format with no sign (Alexa reads the word better), no ".00", and their currency word. */
const rupees = (n: number, lang: Lang, o: SpeechMoney = {}): string => {
  const word = o.currencyName ?? "rupees";
  const spoken = lang === "hi" && word === "rupees" ? "रुपये" : word;
  return `${formatMoney(Math.abs(n), { symbol: "", locale: (o.money ?? DEFAULT_MONEY).locale }).replace(/[.,]00$/, "")} ${spoken}`;
};
const pct = (n: number): string => String(Math.round(Math.abs(n) * 100) / 100);

/** The portfolio in a few spoken sentences. Figures only: nothing about what to buy or sell. */
export function portfolioSpeech(s: PortfolioSummary, lang: Lang, o: SpeechMoney = {}): string {
  if (s.value === 0 && s.invested === 0) return lang === "hi" ? "आपके खाते में अभी कोई होल्डिंग नहीं है।" : "You have no holdings right now.";
  const up = s.dayChange >= 0;
  const gain = s.pnl >= 0;
  if (lang === "hi") {
    return `आपका पोर्टफोलियो ${rupees(s.value, lang, o)} का है। आज यह ${pct(s.dayChangePct)} प्रतिशत ${up ? "ऊपर" : "नीचे"} है। कुल ${gain ? "मुनाफ़ा" : "घाटा"} ${rupees(s.pnl, lang, o)} है।`;
  }
  return `Your portfolio is worth ${rupees(s.value, lang, o)}. It is ${up ? "up" : "down"} ${pct(s.dayChangePct)} percent today, ${rupees(s.dayChange, lang, o)}. Overall you have a ${gain ? "profit" : "loss"} of ${rupees(s.pnl, lang, o)}.`;
}

const FIRST_TASKS = 3;

/** The count of open tasks and the first few titles. */
export function tasksSpeech(rows: TaskRow[], lang: Lang): string {
  if (rows.length === 0) return lang === "hi" ? "आपका कोई काम बाकी नहीं है।" : "You have no open tasks.";
  const names = rows.slice(0, FIRST_TASKS).map((r) => r.title).join(", ");
  if (lang === "hi") return `आपके ${rows.length} काम बाकी हैं। ${names}।`;
  return `You have ${rows.length} open ${rows.length === 1 ? "task" : "tasks"}. ${rows.length === 1 ? "It is" : rows.length > FIRST_TASKS ? "The first three are" : "They are"}: ${names}.`;
}

/** Friend's own state in a sentence or two. */
export function statusSpeech(s: { openTasks: number; brokerLoggedIn: boolean | null }, lang: Lang): string {
  if (lang === "hi") {
    return `फ्रेंड चल रहा है। ${s.openTasks} काम बाकी हैं।${s.brokerLoggedIn === false ? " ज़ेरोधा का लॉगिन चाहिए।" : ""}`;
  }
  return `Friend is running. You have ${s.openTasks} open ${s.openTasks === 1 ? "task" : "tasks"}.${s.brokerLoggedIn === false ? " Zerodha needs you to log in." : ""}`;
}
