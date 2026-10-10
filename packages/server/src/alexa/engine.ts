import { LEAD_INS, LEAD_INTENTS, langOf, letMeCheck, say, type Lang, type LeadIntent } from "./phrases";
import { cleanSpeech, shortForVoice } from "./speech";
import type { AlexaRequestBody } from "./verify";

export type FastIntent = "PortfolioIntent" | "WeatherIntent" | "TasksIntent" | "StatusIntent";
const FAST: readonly FastIntent[] = ["PortfolioIntent", "WeatherIntent", "TasksIntent", "StatusIntent"];

export interface AlexaReply {
  speech: string;
  reprompt?: string;
  end: boolean;
  /** The whole answer, when what is spoken is only the start of it (for the screen or a message). */
  full?: string;
}

export interface EngineDeps {
  /** Asks the assistant. May take a long time; the engine does not wait for it past the budget. */
  ask(text: string, locale: string, deviceKey: string): Promise<string>;
  /** Fixed questions answered straight from Friend's tools, with no model. */
  fast: Partial<Record<FastIntent, (locale: string, slots: Record<string, string>) => Promise<string>>>;
  clock: () => number;
  /** How long to wait for an answer before saying "still working" (default 6500 ms). */
  budgetMs?: number;
  /** How long a late answer is kept for "is it ready" (default 10 minutes). */
  holdMs?: number;
  /** Lets Alexa say "Let me check" while the answer is being made. */
  progressive?: (speech: string) => void;
}

type Slot = { pending: true } | { pending: false; text: string | null; at: number };

/**
 * Turns an Alexa request into what Alexa should say. Fixed questions are answered at once from the tools; open questions go to
 * the assistant, and one that takes longer than the budget is kept for the next "is it ready" instead of making Alexa time out.
 */
export class AlexaEngine {
  private slots = new Map<string, Slot>();

  constructor(private d: EngineDeps) {}

  async handle(req: AlexaRequestBody, deviceKey: string, progressive?: (speech: string) => void): Promise<AlexaReply> {
    const lang = langOf(req.request.locale);
    const locale = req.request.locale ?? "en-IN";
    const stop: AlexaReply = { speech: "", end: true };
    switch (req.request.type) {
      case "LaunchRequest":
        return { speech: say(lang, "greet"), reprompt: say(lang, "greetAgain"), end: false };
      case "SessionEndedRequest":
        return stop;
      case "IntentRequest":
        break;
      default:
        return { speech: say(lang, "unknown"), end: true };
    }

    const name = req.request.intent?.name ?? "";
    const slots: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.request.intent?.slots ?? {})) if (typeof v?.value === "string" && v.value.trim()) slots[k] = v.value.trim();

    if (name === "AMAZON.StopIntent" || name === "AMAZON.CancelIntent") return stop;
    if (name === "AMAZON.HelpIntent") return { speech: say(lang, "help"), reprompt: say(lang, "whatDo"), end: false };
    if (name === "AMAZON.NavigateHomeIntent") return stop;
    if (name === "ReadyIntent") return this.ready(deviceKey, lang);
    if ((FAST as readonly string[]).includes(name)) return this.fast(name as FastIntent, locale, slots, lang);
    if ((LEAD_INTENTS as readonly string[]).includes(name)) {
      const q = slots.q;
      if (!q) return { speech: say(lang, "whatDo"), reprompt: say(lang, "whatDo"), end: false };
      return this.open(`${LEAD_INS[name as LeadIntent][lang]} ${q}`, locale, deviceKey, lang, progressive ?? this.d.progressive);
    }
    return { speech: say(lang, "unknown"), end: true };
  }

  private async fast(name: FastIntent, locale: string, slots: Record<string, string>, lang: Lang): Promise<AlexaReply> {
    const run = this.d.fast[name];
    if (!run) return { speech: say(lang, "unavailable"), end: true };
    try {
      return this.spoken(await run(locale, slots));
    } catch {
      return { speech: say(lang, "failed"), end: true };
    }
  }

  private ready(key: string, lang: Lang): AlexaReply {
    const slot = this.slots.get(key);
    if (slot?.pending) return { speech: say(lang, "working"), end: false };
    if (!slot || this.d.clock() - slot.at > (this.d.holdMs ?? 600_000)) {
      this.slots.delete(key);
      return { speech: say(lang, "nothing"), end: true };
    }
    this.slots.delete(key);
    return slot.text === null ? { speech: say(lang, "failed"), end: true } : this.spoken(slot.text);
  }

  private async open(text: string, locale: string, key: string, lang: Lang, progressive?: (speech: string) => void): Promise<AlexaReply> {
    const existing = this.slots.get(key);
    if (existing?.pending) return { speech: say(lang, "working"), end: false };
    this.slots.delete(key);
    try {
      progressive?.(letMeCheck(lang));
    } catch {
      /* a failed "let me check" must not stop the answer */
    }

    const slot: Slot = { pending: true };
    this.slots.set(key, slot);
    const work = this.d.ask(text, locale, key).then(
      (answer) => ({ ok: true as const, answer }),
      () => ({ ok: false as const }),
    );
    let timer: ReturnType<typeof setTimeout> | undefined;
    const waited = await Promise.race([
      work,
      new Promise<"late">((resolve) => {
        timer = setTimeout(() => resolve("late"), this.d.budgetMs ?? 6500);
      }),
    ]);
    clearTimeout(timer);

    if (waited === "late") {
      void work.then((r) => {
        // only keep it if nothing newer replaced the slot
        if (this.slots.get(key) === slot) this.slots.set(key, { pending: false, text: r.ok ? r.answer : null, at: this.d.clock() });
      });
      return { speech: say(lang, "working"), reprompt: say(lang, "working"), end: false };
    }
    this.slots.delete(key);
    return waited.ok ? this.spoken(waited.answer) : { speech: say(lang, "failed"), end: true };
  }

  private spoken(answer: string): AlexaReply {
    const short = shortForVoice(answer);
    return short.truncated ? { speech: short.spoken, end: true, full: cleanSpeech(answer) } : { speech: short.spoken, end: true };
  }
}
