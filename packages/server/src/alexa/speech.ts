/** What Alexa may say in one reply (Amazon's limit for plain speech is 8000 characters). */
export const MAX_SPEECH = 8000;
const SHORT_SENTENCES = 3;
const SHORT_MAX = 600;

/**
 * Turns an answer written for a screen into words for the ear: no markdown marks, no angle brackets, no ampersands, no line
 * breaks. Rupee signs and Devanagari stay. Longer than `max` is cut at the last full sentence.
 */
export function cleanSpeech(text: string, max = MAX_SPEECH): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/[`*_#>]/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/&/g, " and ")
    .replace(/^\s*[-•]\s+/gm, "")
    .replace(/\s*\n+\s*/g, ". ")
    .replace(/\.\s*\./g, ".")
    .replace(/\s+/g, " ")
    .trim();
  if (plain.length <= max) return plain;
  const cut = plain.slice(0, max);
  const end = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("।"), cut.lastIndexOf("? "), cut.lastIndexOf("! "));
  return end > 0 ? cut.slice(0, end + 1) : cut.replace(/\s+\S*$/, "");
}

/** Sentences end at a full stop, question mark, exclamation mark or danda that is followed by a space ("1.2" stays whole). */
const sentences = (s: string): string[] => s.split(/(?<=[.!?।])\s+/).map((x) => x.trim()).filter(Boolean);

/** The first few sentences, short enough to listen to; `truncated` tells the caller there is more to show elsewhere. */
export function shortForVoice(text: string): { spoken: string; truncated: boolean } {
  const clean = cleanSpeech(text);
  const all = sentences(clean);
  let spoken = all.slice(0, SHORT_SENTENCES).join(" ");
  let truncated = all.length > SHORT_SENTENCES;
  if (spoken.length > SHORT_MAX) {
    spoken = cleanSpeech(spoken, SHORT_MAX);
    if (spoken.length > SHORT_MAX) spoken = spoken.slice(0, SHORT_MAX);
    truncated = true;
  }
  return { spoken, truncated };
}
