/** A speaking voice Friend can use (a Piper voice). Every id here exists in Piper's voice catalog; each downloads once, about 60 MB. */
export interface VoiceChoice {
  /** The Piper voice name, such as en_US-amy-medium. */
  id: string;
  /** What the owner sees. */
  name: string;
  gender: "female" | "male";
  accent: string;
  /** A short remark: smaller, original, and so on. */
  note?: string;
}

export const VOICE_CHOICES: VoiceChoice[] = [
  { id: "en_US-amy-medium", name: "Amy", gender: "female", accent: "American" },
  { id: "en_US-kristin-medium", name: "Kristin", gender: "female", accent: "American" },
  { id: "en_US-hfc_female-medium", name: "Hannah", gender: "female", accent: "American", note: "clear and steady" },
  { id: "en_GB-jenny_dioco-medium", name: "Jenny", gender: "female", accent: "British" },
  { id: "en_GB-alba-medium", name: "Alba", gender: "female", accent: "Scottish" },
  { id: "en_US-kathleen-low", name: "Kathleen", gender: "female", accent: "American", note: "smaller and faster" },
  { id: "en_US-ryan-medium", name: "Ryan", gender: "male", accent: "American" },
  { id: "en_US-joe-medium", name: "Joe", gender: "male", accent: "American" },
  { id: "en_US-norman-medium", name: "Norman", gender: "male", accent: "American" },
  { id: "en_US-hfc_male-medium", name: "Henry", gender: "male", accent: "American", note: "clear and steady" },
  { id: "en_GB-alan-medium", name: "Alan", gender: "male", accent: "British" },
  { id: "en_GB-northern_english_male-medium", name: "Tom", gender: "male", accent: "Northern English" },
];

/**
 * Voices for the Indian languages. Friend speaks Devanagari text (Hindi, Marathi) with these and English words with the
 * main voice, so a reply that mixes them is read correctly. Each downloads once, about 64 MB.
 */
export const HINDI_VOICES: VoiceChoice[] = [
  { id: "hi_IN-priyamvada-medium", name: "Priyamvada", gender: "female", accent: "Hindi", note: "for personal use (non-commercial licence)" },
  { id: "hi_IN-pratham-medium", name: "Pratham", gender: "male", accent: "Hindi", note: "for personal use (non-commercial licence)" },
  { id: "hi_IN-rohan-medium", name: "Rohan", gender: "male", accent: "Hindi" },
];
export const MARATHI_VOICES: VoiceChoice[] = [{ id: "mr_IN-google-medium", name: "Marathi", gender: "female", accent: "Marathi" }];

export const DEFAULT_HINDI_VOICE = "hi_IN-priyamvada-medium";
export const DEFAULT_MARATHI_VOICE = "mr_IN-google-medium";

/** The voice Friend started with, before anyone chose. It is kept as it is for everyone who never changes it. */
export const ORIGINAL_VOICE: VoiceChoice | { id: string; name: string; accent: string; note: string; gender?: undefined } = {
  id: "en_US-lessac-medium",
  name: "Lessac",
  accent: "American",
  note: "the original voice",
};

const PLAIN = /^[A-Za-z0-9_-]{1,80}$/;
/** What Piper names look like: language_REGION-name-quality. */
const PIPER_NAME = /^[a-z]{2,3}_[A-Z]{2}-[A-Za-z0-9_]+-(x_low|low|medium|high)$/;

export const isCatalogVoice = (id: string): boolean => id === ORIGINAL_VOICE.id || VOICE_CHOICES.some((v) => v.id === id);

export const voiceLabel = (id: string): string => {
  const v = VOICE_CHOICES.find((c) => c.id === id);
  if (v) return `${v.name} (${v.gender}, ${v.accent})`;
  return id === ORIGINAL_VOICE.id ? `${ORIGINAL_VOICE.name} (${ORIGINAL_VOICE.note})` : id;
};

/**
 * What someone typed to choose a voice: a number from the list (1 to 12), "female" or "male" (the first of that kind), a
 * name such as "amy", or a full Piper name for a voice that is not in the list. Anything else is not a voice.
 */
export function resolveVoice(input: string): { id: string; label: string; listed: boolean } | null {
  const t = input.trim();
  if (!t) return null;
  const lower = t.toLowerCase();
  const pick = (v: VoiceChoice) => ({ id: v.id, label: voiceLabel(v.id), listed: true });
  if (/^\d+$/.test(t)) {
    const v = VOICE_CHOICES[Number(t) - 1];
    return v ? pick(v) : null;
  }
  if (lower === "female" || lower === "f" || lower === "woman") return pick(VOICE_CHOICES.find((v) => v.gender === "female")!);
  if (lower === "male" || lower === "m" || lower === "man") return pick(VOICE_CHOICES.find((v) => v.gender === "male")!);
  if (lower === ORIGINAL_VOICE.id.toLowerCase() || lower === ORIGINAL_VOICE.name.toLowerCase()) return { id: ORIGINAL_VOICE.id, label: voiceLabel(ORIGINAL_VOICE.id), listed: true };
  const byId = VOICE_CHOICES.find((v) => v.id.toLowerCase() === lower);
  if (byId) return pick(byId);
  const byName = VOICE_CHOICES.filter((v) => v.name.toLowerCase() === lower);
  if (byName.length === 1) return pick(byName[0]!);
  if (PLAIN.test(t) && PIPER_NAME.test(t)) return { id: t, label: t, listed: false };
  return null;
}
