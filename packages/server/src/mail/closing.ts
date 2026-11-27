/**
 * Knowing when a conversation is over takes judgement, and that is the model's: it is told to answer only what needs an answer and to say
 * why (the `why` of email.reply). What code does is structural, not a list of words: nothing new to answer, too many answers in one
 * conversation (a setting), and mail that announces itself as automatic.
 */

/** What a person wrote this time: without the quoted earlier mail below it and without the signature line of a phone. */
export function newWords(text: string): string {
  const out: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const l = raw.trim();
    if (/^(-{5,}|_{5,}|={5,})/.test(l)) break; // a rule line: the quoted mail starts below it
    if (l.startsWith(">")) continue;
    out.push(l);
  }
  return out.join(" ").replace(/\s+/g, " ").trim();
}

/** Whether the mail brings anything of its own: false when all it holds is the quoted earlier mail (or nothing). */
export function hasNewWords(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(newWords(text));
}

/** A subject without Re: and Fwd: in front, to tell whether two mails belong to one conversation. */
export function threadKey(subject: string): string {
  return subject.replace(/^(\s*(re|fwd?|aw|sv|antw)\s*:\s*)+/i, "").trim().toLowerCase();
}