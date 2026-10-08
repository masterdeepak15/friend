import { createHash } from "node:crypto";

/** A voice failure whose message is safe to show the owner (it never carries paths or internal detail). */
export class VoiceError extends Error {}

export interface Transcription {
  text: string;
  language: string;
  /** The speaker's voiceprint, present only when asked for. `null` when the audio was too short to identify anyone. */
  embedding?: number[] | null;
  embeddingError?: string;
}

export interface Embedding {
  embedding: number[];
  /** Seconds of speech the voiceprint is based on. */
  seconds: number;
}

export interface VoiceService {
  /** True when speech can currently be transcribed and synthesized. */
  available(): boolean;
  transcribe(audio: Buffer, mime: string, language?: string | null, opts?: { embed?: boolean }): Promise<Transcription>;
  /** The voiceprint of a recording (used to enroll the owner). */
  embed(audio: Buffer, mime: string): Promise<Embedding>;
  synthesize(text: string, voice?: string): Promise<Buffer>;
}

export interface HttpVoiceOptions {
  /** Current sidecar address, or null while it is not running (it can change after a restart). */
  baseUrl: () => string | null;
  token: string;
  timeoutMs?: number;
}

const isNumberArray = (v: unknown): v is number[] => Array.isArray(v) && v.length > 0 && v.every((x) => typeof x === "number" && Number.isFinite(x));

/** Talks to the Python sidecar over loopback HTTP. */
export class HttpVoiceService implements VoiceService {
  private healthy = true;

  constructor(private opts: HttpVoiceOptions) {}

  available(): boolean {
    return this.opts.baseUrl() !== null && this.healthy;
  }

  async check(): Promise<boolean> {
    const base = this.opts.baseUrl();
    if (!base) return (this.healthy = false);
    try {
      const res = await fetch(base + "/health", {
        headers: { authorization: `Bearer ${this.opts.token}` },
        signal: AbortSignal.timeout(3000),
      });
      return (this.healthy = res.ok);
    } catch {
      return (this.healthy = false);
    }
  }

  async transcribe(audio: Buffer, mime: string, language?: string | null, opts: { embed?: boolean } = {}): Promise<Transcription> {
    const params: string[] = [];
    if (language) params.push(`language=${encodeURIComponent(language)}`);
    if (opts.embed) params.push("embed=1");
    const res = await this.request("/stt" + (params.length ? `?${params.join("&")}` : ""), {
      method: "POST",
      headers: { "content-type": mime },
      body: new Uint8Array(audio),
    });
    const json = (await res.json()) as { text?: string; language?: string; embedding?: unknown; embeddingError?: unknown };
    const out: Transcription = { text: (json.text ?? "").trim(), language: json.language ?? "en" };
    if (opts.embed) {
      out.embedding = isNumberArray(json.embedding) ? json.embedding : null;
      if (typeof json.embeddingError === "string") out.embeddingError = json.embeddingError;
    }
    return out;
  }

  async embed(audio: Buffer, mime: string): Promise<Embedding> {
    const res = await this.request("/embed", { method: "POST", headers: { "content-type": mime }, body: new Uint8Array(audio) });
    const json = (await res.json()) as { embedding?: unknown; seconds?: unknown };
    if (!isNumberArray(json.embedding) || typeof json.seconds !== "number") throw new VoiceError("unexpected reply from the voice sidecar");
    return { embedding: json.embedding, seconds: json.seconds };
  }

  async synthesize(text: string, voice?: string): Promise<Buffer> {
    const res = await this.request("/tts", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(voice ? { text, voice } : { text }),
    });
    return Buffer.from(await res.arrayBuffer());
  }

  private async request(path: string, init: RequestInit): Promise<Response> {
    const base = this.opts.baseUrl();
    if (!base) throw new VoiceError("the voice sidecar is not running");
    let res: Response;
    try {
      res = await fetch(base + path, {
        ...init,
        headers: { ...(init.headers as Record<string, string>), authorization: `Bearer ${this.opts.token}` },
        signal: AbortSignal.timeout(this.opts.timeoutMs ?? 60_000),
      });
    } catch (e) {
      if ((e as Error).name === "TimeoutError") throw new VoiceError("the voice sidecar timed out");
      this.healthy = false;
      throw new VoiceError("could not reach the voice sidecar");
    }
    this.healthy = true;
    if (!res.ok) {
      let detail = "";
      try {
        detail = ((await res.json()) as { error?: string }).error ?? "";
      } catch {
        /* no JSON body */
      }
      // a 4xx message is ours and safe (e.g. "recording longer than 90 seconds"); 5xx text may hold paths, so it is dropped
      throw new VoiceError(`voice sidecar error (${res.status})${detail && res.status < 500 ? `: ${detail}` : ""}`);
    }
    return res;
  }
}

// ---------------------------------------------------------------- test double

/** A deterministic stand-in voiceprint: same `name` gives nearby vectors, different names give unrelated ones. */
export function fakeEmbedding(name: string, detail = ""): number[] {
  const rng = (seed: string) => {
    let state = createHash("sha256").update(seed).digest().readUInt32LE(0) || 1;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };
  const gauss = (r: () => number) => Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r());
  const base = rng(`voice:${name}`);
  const noise = rng(`voice:${name}|${detail}`);
  const v = Array.from({ length: 256 }, () => gauss(base) + 0.15 * gauss(noise));
  const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / norm);
}

export interface ScriptedUtterance {
  text: string;
  /** Whose voice it is; omit for a recording too short to identify. */
  speaker?: string;
  detail?: string;
}

export interface FakeVoiceOptions {
  transcripts?: (string | ScriptedUtterance)[];
  /** Speakers returned by successive embed() calls (enrollment); the last one repeats. */
  enrollSpeakers?: string[];
  available?: boolean;
  failTranscribe?: boolean;
  failSynthesize?: boolean;
  /** Voices that cannot be loaded (for example not downloaded and no internet). */
  failVoices?: string[];
}

/** Scripted voice for tests: no models, no process. */
export class FakeVoice implements VoiceService {
  transcribed: Buffer[] = [];
  embedded: Buffer[] = [];
  synthesized: string[] = [];
  /** The voice asked for with each synthesized text (undefined: the default). */
  voicesUsed: (string | undefined)[] = [];
  private i = 0;
  private e = 0;

  constructor(private opts: FakeVoiceOptions = {}) {}

  available(): boolean {
    return this.opts.available ?? true;
  }

  async transcribe(audio: Buffer, _mime?: string, _language?: string | null, opts: { embed?: boolean } = {}): Promise<Transcription> {
    this.transcribed.push(audio);
    if (this.opts.failTranscribe) throw new Error("fake transcription failure");
    const idx = this.i++;
    const item = this.opts.transcripts?.[idx] ?? "hello";
    const u: ScriptedUtterance = typeof item === "string" ? { text: item } : item;
    const out: Transcription = { text: u.text, language: "en" };
    if (opts.embed) {
      out.embedding = u.speaker ? fakeEmbedding(u.speaker, u.detail ?? String(idx)) : null;
      if (!u.speaker) out.embeddingError = "not enough speech to recognize a voice";
    }
    return out;
  }

  async embed(audio: Buffer, _mime?: string): Promise<Embedding> {
    this.embedded.push(audio);
    const speakers = this.opts.enrollSpeakers ?? ["owner"];
    const idx = this.e++;
    const speaker = speakers[Math.min(idx, speakers.length - 1)]!;
    return { embedding: fakeEmbedding(speaker, `enroll-${idx}`), seconds: 3 };
  }

  async synthesize(text: string, voice?: string): Promise<Buffer> {
    if (this.opts.failSynthesize) throw new Error("fake synthesis failure");
    if (voice && this.opts.failVoices?.includes(voice)) throw new Error(`fake: the voice ${voice} cannot be loaded`);
    this.synthesized.push(text);
    this.voicesUsed.push(voice);
    return Buffer.concat([Buffer.from("RIFF"), Buffer.from(text)]);
  }
}
