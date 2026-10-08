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

export interface SpeechStream {
  /** More of the reply. Every sentence that is complete is spoken straight away. */
  push(text: string): void;
  /** The reply is finished: says what is left. Resolves when the last clip has been sent. */
  end(): Promise<void>;
}

const fenceCount = (text: string) => (text.match(/```/g) ?? []).length;

/**
 * Where the last finished sentence (or line) in `text` ends, or 0 when there is none yet. A full stop that is part of
 * a number ("31.5") or an abbreviation ("Dr.") does not count, and neither does anything inside a code block.
 */
function lastBoundary(text: string): number {
  for (let i = text.length - 2; i >= 0; i--) {
    const c = text[i]!;
    const lineEnd = c === "\n" && text.slice(0, i).trim() !== "";
    const sentenceEnd = (c === "." || c === "!" || c === "?") && /\s/.test(text[i + 1]!) && !ABBREVIATION.test(text.slice(0, i + 1));
    if ((lineEnd || sentenceEnd) && fenceCount(text.slice(0, i + 1)) % 2 === 0) return i + 1;
  }
  return 0;
}

/** Turns reply text into spoken audio, one sentence at a time, so playback starts early. */
export class Speaker {
  private job = 0;
  private active = false;

  constructor(private voice: VoiceService, private audit: Audit, private voiceName?: string) {}

  /** Says a whole text, sentence by sentence. */
  async speak(text: string, emit: (m: ServerMsg) => void): Promise<void> {
    const s = this.stream(emit);
    s.push(text);
    await s.end();
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
        let wav: Buffer;
        try {
          wav = await this.voice.synthesize(sentence, this.voiceName);
        } catch (e) {
          this.audit.log("voice", "voice.tts_failed", { message: (e as Error).message });
          continue;
        }
        if (!alive()) return; // interrupted while synthesizing
        const chunks = chunkBase64(wav);
        const id = `${job}-${clip++}`;
        chunks.forEach((data, seq) => emit({ type: "audio.chunk", id, seq, last: seq === chunks.length - 1, mime: "audio/wav", data }));
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
    };
  }

  /** Cancels the running job and tells every client to stop playing. */
  interrupt(emit: (m: ServerMsg) => void): void {
    this.job++;
    this.active = false;
    emit({ type: "audio.stop" });
  }
}
