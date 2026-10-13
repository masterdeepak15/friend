/**
 * Hands-free: does what was heard begin with a greeting and the assistant's name ("hey Maya, ...")? The name is the one
 * chosen when the account was made. Pure, so it is easy to test.
 */

const GREETINGS = new Set(["hey", "hay", "hi", "hello", "hellow", "hallo", "hullo", "ok", "okay", "yo", "he", "हे", "हाय", "हॅलो", "हेलो", "हैलो", "हलो", "ओके"]);
const WORD = /[\p{L}\p{M}\p{N}'’]+/gu;
/** What may sit between the name and the request. */
const GAP = /^[\s,.:;!?…\-–—]+/u;

function distance(a: string, b: string): number {
  const row = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    let prev = row[0]!;
    row[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const keep = row[j]!;
      row[j] = Math.min(row[j]! + 1, row[j - 1]! + 1, prev + (a[i - 1] === b[j - 1] ? 0 : 1));
      prev = keep;
    }
  }
  return row[b.length]!;
}

/** One wrong, missing or extra letter is forgiven, but only in a word of four or more letters: short names would match too much. */
const sameWord = (heard: string, name: string): boolean => heard === name || (name.length >= 4 && distance(heard, name) <= 1);

export interface WakeMatch {
  matched: boolean;
  /** What was said after the name, ready to run. Empty when only the name was said. */
  rest: string;
}

export function matchWake(text: string, name: string): WakeMatch {
  const no: WakeMatch = { matched: false, rest: "" };
  const wanted = [...name.normalize("NFC").toLowerCase().matchAll(WORD)].map((m) => m[0]);
  if (wanted.length === 0) return no;
  const words = [...text.normalize("NFC").matchAll(WORD)].map((m) => ({ low: m[0].toLowerCase(), end: m.index! + m[0].length }));
  let at = 0;
  // the greeting is optional, but nothing else may come before the name
  if (words[0] && GREETINGS.has(words[0].low)) at = 1;
  for (let i = 0; i < wanted.length; i++) {
    const heard = words[at + i];
    if (!heard || !sameWord(heard.low, wanted[i]!)) return no;
  }
  const last = words[at + wanted.length - 1]!;
  return { matched: true, rest: text.normalize("NFC").slice(last.end).replace(GAP, "").trim() };
}
