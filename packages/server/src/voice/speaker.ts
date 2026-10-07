import type { ServerMsg } from "@friend/protocol";
import type { Audit } from "../audit";
import type { VoiceService } from "./service";

/** Largest base64 payload in one audio.chunk message. */
export const MAX_CHUNK_CHARS = 48 * 1024;
const MAX_SENTENCE_CHARS = 300;
const ABBREVIATION = /\b(?:Mr|Mrs|Ms|Dr|Prof|Sr|Jr|St|vs|etc|e\.g|i\.e)\.$/i;

/** Markdown reply text turned into plain words fit for a speech engine. */
export function speechText(markdown: string): string {
  let s = markdown.replace(/```[\s\S]*?```/g, " "); // fenced code blocks are not read aloud
  s = s.replace(/<[^>]+>/g, " ");
  s = s.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/https?:\/\/\S+/g, " ");
  s = s.replace(/\p{Extended_Pictographic}|️|‍/gu, "");
  const lines = s
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s{0,3}(?:#{1,6}|[-*+]|\d+[.)]|>)\s+/, "").replace(/[*~]+/g, "").trim())
    .filter(Boolean);
  return lines
    .map((l) => (/[.!?:;]$/.test(l) ? l : l + "."))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}

function breakLong(sentence: string): string[] {
  if (sentence.length <= MAX_SENTENCE_CHARS) return [sentence];
  const out: string[] = [];
  let cur = "";
  const flush = () => {
    if (cur.trim()) out.push(cur.trim());
    cur = "";
  };
  for (const piece of sentence.split(/(?<=[,;:])\s+/)) {
    if (cur && (cur + " " + piece).length > MAX_SENTENCE_CHARS) flush();
    cur = cur ? cur + " " + piece : piece;
    while (cur.length > MAX_SENTENCE_CHARS) {
      const cut = cur.lastIndexOf(" ", MAX_SENTENCE_CHARS);
      const at = cut > 0 ? cut : MAX_SENTENCE_CHARS;
      out.push(cur.slice(0, at).trim());
      cur = cur.slice(at).trim();
    }
  }
  flush();
  return out;
}

export function splitSentences(text: string): string[] {
  const merged: string[] = [];
  for (const piece of text.split(/(?<=[.!?])\s+/)) {
    const prev = merged[merged.length - 1];
    if (prev !== undefined && ABBREVIATION.test(prev)) merged[merged.length - 1] = `${prev} ${piece}`;
    else merged.push(piece);
  }
  return merged.filter((s) => /[\p{L}\p{N}]/u.test(s)).flatMap((s) => breakLong(s.trim()));
}

/** Base64 pieces of `buf`, each at most `maxChars` long. An empty buffer yields one empty piece. */
export function chunkBase64(buf: Buffer, maxChars: number = MAX_CHUNK_CHARS): string[] {
  if (buf.length === 0) return [""];
  const bytes = Math.floor(maxChars / 4) * 3;
  const out: string[] = [];
  for (let i = 0; i < buf.length; i += bytes) out.push(buf.subarray(i, i + bytes).toString("base64"));
  return out;
}

/** Turns reply text into spoken audio, one sentence at a time, so playback starts early. */
export class Speaker {
  private job = 0;
  private active = false;

  constructor(private voice: VoiceService, private audit: Audit, private voiceName?: string) {}

  async speak(text: string, emit: (m: ServerMsg) => void): Promise<void> {
    const sentences = splitSentences(speechText(text));
    if (sentences.length === 0) return;
    if (this.active) emit({ type: "audio.stop" }); // a newer reply replaces the one still playing
    const job = ++this.job;
    this.active = true;
    try {
      for (const [i, sentence] of sentences.entries()) {
        if (job !== this.job) return;
        let wav: Buffer;
        try {
          wav = await this.voice.synthesize(sentence, this.voiceName);
        } catch (e) {
          this.audit.log("voice", "voice.tts_failed", { message: (e as Error).message });
          continue;
        }
        if (job !== this.job) return; // interrupted while synthesizing: send nothing more
        const chunks = chunkBase64(wav);
        chunks.forEach((data, seq) =>
          emit({ type: "audio.chunk", id: `${job}-${i}`, seq, last: seq === chunks.length - 1, mime: "audio/wav", data }),
        );
      }
    } finally {
      if (job === this.job) this.active = false;
    }
  }

  /** Cancels the running job and tells every client to stop playing. */
  interrupt(emit: (m: ServerMsg) => void): void {
    this.job++;
    this.active = false;
    emit({ type: "audio.stop" });
  }
}
