/** Words Alexa reserves: wake words, "skill"/"app", and the phrases that start a skill. They cannot be inside an invocation name. */
const BANNED = new Set(["alexa", "amazon", "echo", "skill", "app", "ask", "tell", "open", "start", "run", "enable", "launch", "load", "begin", "use"]);
const MAX_LENGTH = 50;

/**
 * Why a name cannot be the skill's invocation name, or null when it can. Amazon's rules for English: two or more words, lower-case
 * letters, spaces and apostrophes only, no wake words and no launch phrases. (A single word is only allowed for registered brands.)
 */
export function invocationNameProblem(name: string): string | null {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return 'Use two or more words, like "jarvis assistant". Amazon does not allow a single word.';
  if (name.length > MAX_LENGTH) return `That is too long (at most ${MAX_LENGTH} characters).`;
  if (!/^[a-z' ]+$/.test(name)) return "Use lower-case letters, spaces and apostrophes only. Spell numbers out as words.";
  const bad = words.find((w) => BANNED.has(w));
  if (bad) return `The word "${bad}" cannot be in the name (it is reserved by Alexa).`;
  return null;
}
