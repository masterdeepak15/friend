import type { ServerMsg } from "@friend/protocol";
import type { Audit } from "../audit";
import { planSpeech } from "./lang";
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
    .map((l) => (/[.!?:;।॥]$/.test(l) ? l : l + "."))
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
  for (const piece of text.split(/(?<=[.!?।॥])\s+/)) {
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

export interface SpeechStream {
  /** More of the reply. Every sentence that is complete is spoken straight away. */
  push(text: string): void;
  /** The reply is finished: says what is left. Resolves when the last clip has been sent. */
  end(): Promise<void>;
  /** Resolves when everything sent so far has had time to play on the screens (or at once when it was interrupted). When no sound could be made, the time it takes to read the fallback text. */
  playedOut(fallbackText?: string): Promise<void>;
}

/** How long a WAV clip plays, in milliseconds, or null when it cannot be read. */
export function wavMs(wav: Buffer): number | null {
  if (wav.length < 44 || wav.toString("ascii", 0, 4) !== "RIFF" || wav.toString("ascii", 8, 12) !== "WAVE") return null;
  let off = 12;
  let bytesPerSecond = 0;
  while (off + 8 <= wav.length) {
    const id = wav.toString("ascii", off, off + 4);
    const size = wav.readUInt32LE(off + 4);
    if (id === "fmt " && off + 20 <= wav.length) bytesPerSecond = wav.readUInt32LE(off + 16);
    if (id === "data") {
      const length = Math.min(size, wav.length - off - 8); // a clip written as a stream says 0 or a huge size: what is there is what plays
      return bytesPerSecond > 0 ? (length / bytesPerSecond) * 1000 : null;
    }
    off += 8 + size + (size % 2);
  }
  return null;
}

/** When a clip's length cannot be read: about how long the words take to say. */
const guessMs = (text: string): number => Math.max(600, text.trim().split(/\s+/).length * 380);
/** The quiet after a spoken text, so one thing is not run into the next. */
const GAP_MS = 350;

const fenceCount = (text: string) => (text.match(/```/g) ?? []).length;

/**
 * Where the last finished sentence (or line) in `text` ends, or 0 when there is none yet. A full stop that is part of
 * a number ("31.5") or an abbreviation ("Dr.") does not count, and neither does anything inside a code block.
 */
function lastBoundary(text: string): number {
  for (let i = text.length - 2; i >= 0; i--) {
    const c = text[i]!;
    const lineEnd = c === "\n" && text.slice(0, i).trim() !== "";
    const sentenceEnd = (c === "." || c === "!" || c === "?" || c === "।" || c === "॥") && /\s/.test(text[i + 1]!) && !ABBREVIATION.test(text.slice(0, i + 1));
    if ((lineEnd || sentenceEnd) && fenceCount(text.slice(0, i + 1)) % 2 === 0) return i + 1;
  }
  return 0;
}

/** Turns reply text into spoken audio, one sentence at a time, so playback starts early. */
export class Speaker {
  private job = 0;
  private active = false;

  /** `voiceName` may be a function, so a change of voice in the settings is used by the very next sentence. */
  constructor(
    private voice: VoiceService,
    private audit: Audit,
    private voiceName?: string | (() => string | undefined),
    /** The voices for Hindi and Marathi; a sentence in Devanagari is said with them, and English words with the main voice. */
    private languages?: () => { hindi?: string | undefined; marathi?: string | undefined },
  ) {}

  /** Says a whole text, sentence by sentence. Resolves when the last clip has been sent (it may still be playing). */
  async speak(text: string, emit: (m: ServerMsg) => void): Promise<void> {
    const s = this.stream(emit);
    s.push(text);
    await s.end();
  }

  /** Says a text and resolves when it has been heard, not only sent: for a presentation, which goes on to the next item only then. */
  async say(text: string, emit: (m: ServerMsg) => void): Promise<void> {
    const s = this.stream(emit);
    s.push(text);
    await s.end();
    await s.playedOut(text);
  }

  /**
   * Speaks a reply while it is still being written: every sentence is synthesized and sent as soon as it is
   * finished, in order, so the voice keeps up with the captions instead of starting after them.
   */
  stream(emit: (m: ServerMsg) => void): SpeechStream {
    if (this.active) emit({ type: "audio.stop" }); // a newer reply replaces the one still playing
    const job = ++this.job;
    this.active = true;
    const alive = () => job === this.job;
    const queue: string[] = [];
    let pending = "";
    let ended = false;
    let wake: (() => void) | null = null;
    let clip = 0;
    /** When the first clip went out and how much sound has been sent: the screens play the clips one after the other, so this is when the last one ends. */
    let firstAt = 0;
    let soundMs = 0;
    const begun = Date.now();
    const poke = () => {
      const w = wake;
      wake = null;
      w?.();
    };

    const worker = (async () => {
      for (;;) {
        while (queue.length === 0 && !ended && alive()) await new Promise<void>((r) => (wake = r));
        if (!alive()) return; // interrupted or replaced: send nothing more
        const sentence = queue.shift();
        if (sentence === undefined) return; // the reply ended and everything was said
        const main = typeof this.voiceName === "function" ? this.voiceName() : this.voiceName;
        // a sentence that mixes Hindi or Marathi with English is said in pieces, each with the voice for its language
        for (const part of planSpeech(sentence, { main, ...(this.languages?.() ?? {}) })) {
          const attempt = async (voice: string | undefined): Promise<Buffer | null> => {
            try {
              return await this.voice.synthesize(part.text, voice);
            } catch (e) {
              this.audit.log("voice", "voice.tts_failed", { message: (e as Error).message, voice: voice ?? "default" });
              return null;
            }
          };
          let wav = await attempt(part.voice);
          if (!wav && part.voice !== main) {
            // that language's voice is not available: the other Devanagari voice reads the script far better than an English one, and anything beats silence
            const langs = this.languages?.() ?? {};
            const sibling = part.voice === langs.hindi ? langs.marathi : part.voice === langs.marathi ? langs.hindi : undefined;
            if (sibling && sibling !== part.voice) wav = await attempt(sibling);
            if (!wav) wav = await attempt(main);
          }
          if (!wav) continue;
          if (!alive()) return; // interrupted while synthesizing
          const chunks = chunkBase64(wav);
          const id = `${job}-${clip++}`;
          chunks.forEach((data, seq) => emit({ type: "audio.chunk", id, seq, last: seq === chunks.length - 1, mime: "audio/wav", data }));
          if (firstAt === 0) firstAt = Date.now();
          soundMs += wavMs(wav) ?? guessMs(part.text);
        }
      }
    })().finally(() => {
      if (alive()) this.active = false;
    });

    /** Moves finished sentences from the pending text to the queue. At the end, everything left goes. */
    const take = (final: boolean) => {
      const open = fenceCount(pending) % 2 === 1;
      if (open && !final) return; // inside a code block: wait for it to close
      const text = open ? pending.slice(0, pending.lastIndexOf("```")) : pending; // an unclosed block is never read
      const cut = final ? text.length : lastBoundary(text);
      if (cut === 0) return;
      pending = final ? "" : text.slice(cut);
      queue.push(...splitSentences(speechText(text.slice(0, cut))));
      poke();
    };

    return {
      push: (t) => {
        if (!alive() || ended) return;
        pending += t;
        take(false);
      },
      end: () => {
        ended = true;
        if (alive()) take(true);
        poke();
        return worker;
      },
      playedOut: async (fallbackText) => {
        while (alive()) {
          const until = firstAt > 0 ? firstAt + soundMs + GAP_MS : begun + (fallbackText ? guessMs(speechText(fallbackText)) : 0); // no sound: the time to read it
          const left = until - Date.now();
          if (left <= 0) return;
          await new Promise<void>((r) => setTimeout(r, Math.min(left, 200)));
        }
      },
    };
  }

  /** Cancels the running job and tells every client to stop playing. */
  interrupt(emit: (m: ServerMsg) => void): void {
    this.job++;
    this.active = false;
    emit({ type: "audio.stop" });
  }
}
