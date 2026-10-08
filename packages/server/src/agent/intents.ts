/**
 * Requests that clearly need one of two read-only data tools. A small local model often answers these with made-up
 * numbers or only says it will look, so the gateway makes the call itself and the model only has to summarize.
 */
export interface AutoCall {
  name: "weather.get" | "system.info";
  args: Record<string, unknown>;
}

const MAX_CALLS = 2;
const NOT_A_PLACE = /^(?:my|the|this|that|a|an|your|our|here|there|town|city|area|notes?|general|it|me|you|today|tomorrow|now)\b/i;

/** "weather in Pune", "how is the weather for new delhi right now": the place named after in/at/for/of/near. */
function weatherCity(text: string): string | null {
  const m = /\b(?:in|at|for|of|near)\s+([\p{L}][\p{L}.'-]*(?:\s+[\p{L}][\p{L}.'-]*){0,3}?)(?=\s*(?:[?.!,;:]|$)|\s+(?:and|also|today|tomorrow|tonight|now|right|please|on|then|so|to|with)\b)/iu.exec(text);
  const city = m?.[1]?.replace(/\s+/g, " ").replace(/[.'-]+$/, "").trim(); // not the full stop that ends the sentence
  if (!city || city.length > 60 || NOT_A_PLACE.test(city)) return null;
  return city;
}

export function detectIntents(text: string): AutoCall[] {
  const found: { at: number; call: AutoCall }[] = [];

  const weather = /\b(weather|forecast|raining|rain|umbrella)\b/i.exec(text);
  if (weather) {
    const city = weatherCity(text);
    if (city) found.push({ at: weather.index, call: { name: "weather.get", args: { city } } });
  }

  // a computer word and a "how is it doing" word, so "the solar system" or "improve my memory" stay ordinary talk
  const thing = /\b(computer|pc|laptop|machine|cpu|ram|disk|storage|system)\b/i.exec(text) ?? /\bmemory\b/i.exec(text);
  const aspect = /\b(stats?|status|info|information|usage|health|load|performance|doing|running|free|space)\b/i.test(text);
  const talkingAboutTheSolarSystem = /\b(solar|immune|nervous|digestive|ecosystem|operating)\s+system\b/i.test(text);
  const memoryOfAPerson = /\b(improve|train|boost|my)\s+memory\b/i.test(text) && !/\b(usage|status|stats?|free|used|ram)\b/i.test(text);
  if (thing && aspect && !talkingAboutTheSolarSystem && !memoryOfAPerson && !(thing[0].toLowerCase() === "system" && /\bstatus of the\b/i.test(text))) {
    found.push({ at: thing.index, call: { name: "system.info", args: {} } });
  }

  return found
    .sort((a, b) => a.at - b.at)
    .slice(0, MAX_CALLS)
    .map((f) => f.call);
}
