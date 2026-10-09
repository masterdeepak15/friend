/**
 * Hindi, Marathi and English in one reply. A speech voice reads one language well, so a sentence is cut into runs by
 * script: Devanagari (Hindi or Marathi) goes to the Hindi or Marathi voice, Latin letters (English words) to the main
 * voice. This works because the assistant is told to write Hindi and Marathi in Devanagari and English in Latin letters.
 */

export type Script = "latin" | "devanagari";

export interface Run {
  text: string;
  script: Script;
}

const DEVANAGARI = /[ऀ-ॿ]/;
const LATIN = /[A-Za-zÀ-ɏ]/;

/** The text cut into runs of one script. Digits, spaces and punctuation stay with the run they follow. */
export function splitRuns(text: string): Run[] {
  const runs: Run[] = [];
  let cur: Run | null = null;
  let lead = "";
  for (const ch of text) {
    const script: Script | null = DEVANAGARI.test(ch) ? "devanagari" : LATIN.test(ch) ? "latin" : null;
    if (script === null) {
      if (cur) cur.text += ch;
      else lead += ch;
      continue;
    }
    if (!cur || cur.script !== script) {
      cur = { text: lead + ch, script };
      lead = "";
      runs.push(cur);
    } else cur.text += ch;
  }
  return runs;
}

// Words that settle which language a Devanagari sentence is in. Only words that mean one thing in one language.
const MARATHI_WORDS = new Set(["आहे", "आहेत", "नाही", "नाहीत", "मी", "तुम्ही", "आम्ही", "माझा", "माझी", "माझे", "तुमचा", "तुमची", "तुमचे", "काय", "आणि", "होते", "होता", "होती", "करा", "करतो", "करते", "मला", "तुला", "त्याला", "तिला", "सांगा", "पाहिजे", "झाले", "झाला", "झाली", "नको", "कसे", "कसा", "कशी", "येथे", "इथे", "तिथे", "आपण", "काही", "खूप", "पण", "म्हणून", "आज", "उद्या", "आता"]);
const HINDI_WORDS = new Set(["है", "हैं", "था", "थी", "थे", "नहीं", "मैं", "हम", "आप", "तुम", "क्या", "और", "की", "के", "को", "में", "यह", "वह", "कि", "भी", "तो", "रहा", "रही", "रहे", "हूँ", "हूं", "मेरा", "मेरी", "मेरे", "आपका", "आपकी", "आपके", "करो", "करना", "चाहिए", "बहुत", "लेकिन", "कुछ", "कैसे", "कैसा", "कैसी", "यहाँ", "यहां", "वहाँ", "वहां", "आज", "कल", "अब"]);

/** Hindi or Marathi? Marathi shows in its own words and in the letter ळ; when it is not clear, Hindi. */
export function devanagariLanguage(text: string): "hi" | "mr" {
  let marathi = (text.match(/ळ/g) ?? []).length * 2;
  let hindi = 0;
  for (const w of text.match(/[ऀ-ॿ]+/g) ?? []) {
    const bare = w.replace(/[।॥]/g, "");
    // "आज" and "आता/अब" exist in both and add nothing: only the words that differ count
    if (MARATHI_WORDS.has(bare) && !HINDI_WORDS.has(bare)) marathi++;
    else if (HINDI_WORDS.has(bare) && !MARATHI_WORDS.has(bare)) hindi++;
  }
  return marathi > hindi ? "mr" : "hi";
}

export interface SpeechVoices {
  /** The main voice (English); undefined means the speech engine's default. */
  main?: string | undefined;
  hindi?: string | undefined;
  marathi?: string | undefined;
}

export interface Part {
  text: string;
  /** The voice to say it with; undefined is the engine's default voice. */
  voice: string | undefined;
}

const hasLetters = (s: string) => /[\p{L}\p{N}]/u.test(s);

/**
 * How to say one sentence: a single part with the main voice when it is plain English (or when no Hindi or Marathi voice
 * is set), otherwise one part per run, with Devanagari going to the Hindi or Marathi voice. Neighbouring runs that use
 * the same voice are joined, and a run with nothing to say (only punctuation) is joined to the one before it.
 */
export function planSpeech(sentence: string, voices: SpeechVoices): Part[] {
  const runs = splitRuns(sentence);
  const dev = runs.filter((r) => r.script === "devanagari");
  if (dev.length === 0) return [{ text: sentence, voice: voices.main }];
  const lang = devanagariLanguage(dev.map((r) => r.text).join(" "));
  const indian = lang === "mr" ? voices.marathi : voices.hindi;
  if (!indian) return [{ text: sentence, voice: voices.main }];
  const parts: Part[] = [];
  for (const r of runs) {
    const voice = r.script === "devanagari" ? indian : voices.main;
    const last = parts[parts.length - 1];
    if (last && (last.voice === voice || !hasLetters(r.text))) last.text += r.text;
    else parts.push({ text: r.text, voice });
  }
  return parts;
}

/**
 * A line for the model about the language to answer in, or null when it is plain English. `spoken` is the language the
 * speech recognizer heard (for example "hi" or "mr"); typed text is judged by its script.
 */
export function languageNote(text: string, spoken?: string): string | null {
  const dev = text.match(/[ऀ-ॿ]/g)?.length ?? 0;
  const latin = text.match(/[A-Za-z]/g)?.length ?? 0;
  const code = (spoken ?? "").toLowerCase().slice(0, 2);
  const lang = dev > 0 ? devanagariLanguage(text) : code === "mr" ? "mr" : code === "hi" ? "hi" : null;
  if (!lang) return null;
  const name = lang === "mr" ? "Marathi" : "Hindi";
  const mixed = dev > 0 && latin > 0;
  return mixed
    ? `Language: the owner is mixing ${name} and English. Answer the same way: ${name} in Devanagari script, English words in Latin letters.`
    : `Language: the owner is speaking ${name}. Answer in ${name}, written in Devanagari script (not Roman letters), so your voice can read it. Keep English names and technical words in Latin letters.`;
}
