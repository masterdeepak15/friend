/** A voice failure whose message is safe to show the owner (it never carries paths or internal detail). */
export class VoiceError extends Error {}

export interface VoiceService {
  /** True when speech can currently be transcribed and synthesized. */
  available(): boolean;
  transcribe(audio: Buffer, mime: string, language?: string | null): Promise<{ text: string; language: string }>;
  synthesize(text: string, voice?: string): Promise<Buffer>;
}

export interface HttpVoiceOptions {
  /** Current sidecar address, or null while it is not running (it can change after a restart). */
  baseUrl: () => string | null;
  token: string;
  timeoutMs?: number;
}

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

  async transcribe(audio: Buffer, mime: string, language?: string | null): Promise<{ text: string; language: string }> {
    const q = language ? `?language=${encodeURIComponent(language)}` : "";
    const res = await this.request("/stt" + q, { method: "POST", headers: { "content-type": mime }, body: new Uint8Array(audio) });
    const json = (await res.json()) as { text?: string; language?: string };
    return { text: (json.text ?? "").trim(), language: json.language ?? "en" };
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

export interface FakeVoiceOptions {
  transcripts?: string[];
  available?: boolean;
  failTranscribe?: boolean;
  failSynthesize?: boolean;
}

/** Scripted voice for tests: no models, no process. */
export class FakeVoice implements VoiceService {
  transcribed: Buffer[] = [];
  synthesized: string[] = [];
  private i = 0;

  constructor(private opts: FakeVoiceOptions = {}) {}

  available(): boolean {
    return this.opts.available ?? true;
  }

  async transcribe(audio: Buffer, _mime?: string, _language?: string | null): Promise<{ text: string; language: string }> {
    this.transcribed.push(audio);
    if (this.opts.failTranscribe) throw new Error("fake transcription failure");
    return { text: this.opts.transcripts?.[this.i++] ?? "hello", language: "en" };
  }

  async synthesize(text: string): Promise<Buffer> {
    if (this.opts.failSynthesize) throw new Error("fake synthesis failure");
    this.synthesized.push(text);
    return Buffer.concat([Buffer.from("RIFF"), Buffer.from(text)]);
  }
}
