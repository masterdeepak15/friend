/** Words Alexa reserves: wake words, "skill"/"app", and the phrases that start a skill. They cannot be inside an invocation name. */
const BANNED = new Set(["alexa", "amazon", "echo", "skill", "app", "ask", "tell", "open", "start", "run", "enable", "launch", "load", "begin", "use"]);
const MAX_LENGTH = 50;

/**
 * Why a name cannot be the Alexa skill's invocation name, or null when it can. Amazon's rules for English: lower-case letters,
 * spaces and apostrophes only, no wake words and no launch phrases. Amazon asks for two or more words when a skill is published
 * (a single word needs a registered brand), but a skill kept in development mode on the owner's own account takes one word, so
 * one word is allowed here. The server and the settings screen use the same rules.
 */
export function invocationNameProblem(name: string): string | null {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length < 1) return "Enter the name you will say after \"Alexa, ask\".";
  if (name.length > MAX_LENGTH) return `That is too long (at most ${MAX_LENGTH} characters).`;
  if (!/^[a-z' ]+$/.test(name)) return "Use lower-case letters, spaces and apostrophes only. Spell numbers out as words.";
  const bad = words.find((w) => BANNED.has(w));
  if (bad) return `The word "${bad}" cannot be in the name (it is reserved by Alexa).`;
  return null;
}
