import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AudioPlayer } from "./player";
import { Recorder } from "./recorder";

// ---------------------------------------------------------------- fakes

class FakeTrack {
  stopped = false;
  stop() {
    this.stopped = true;
  }
}
class FakeStream {
  tracks = [new FakeTrack()];
  getTracks() {
    return this.tracks;
  }
}
let lastStream: FakeStream | null = null;
let lastRecorder: FakeRecorder | null = null;
let analyserValue = 128;
let contexts: FakeAudioContext[] = [];

class FakeRecorder {
  static isTypeSupported(t: string) {
    return t === "audio/webm;codecs=opus";
  }
  state: "inactive" | "recording" = "inactive";
  mimeType: string;
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(public stream: FakeStream, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? "audio/webm";
    lastRecorder = this;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])], { type: this.mimeType }) });
    this.ondataavailable?.({ data: new Blob([new Uint8Array([4, 5])], { type: this.mimeType }) });
    this.onstop?.();
  }
}

class FakeAnalyser {
  fftSize = 0;
  getByteTimeDomainData(arr: Uint8Array) {
    arr.fill(analyserValue);
  }
  connect() {}
}
class FakeSource {
  onended: (() => void) | null = null;
  started = false;
  stopped = false;
  buffer: unknown = null;
  connect() {}
  start() {
    this.started = true;
  }
  stop() {
    this.stopped = true;
  }
}
class FakeAudioContext {
  state = "running";
  destination = {};
  sources: FakeSource[] = [];
  decoded: ArrayBuffer[] = [];
  failDecodeFor: number[] = [];
  closed = false;
  constructor() {
    contexts.push(this);
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  createBufferSource() {
    const s = new FakeSource();
    this.sources.push(s);
    return s;
  }
  async decodeAudioData(buf: ArrayBuffer) {
    this.decoded.push(buf);
    if (this.failDecodeFor.includes(this.decoded.length)) throw new Error("bad audio");
    return { duration: 1 };
  }
  async resume() {
    this.state = "running";
  }
  async close() {
    this.closed = true;
  }
}

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
const chunk = (id: string, seq: number, last: boolean, bytes: number[]) => ({ id, seq, last, mime: "audio/wav", data: b64(bytes) });
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  lastStream = null;
  lastRecorder = null;
  analyserValue = 128;
  contexts = [];
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("navigator", {
    mediaDevices: {
      getUserMedia: vi.fn(async () => (lastStream = new FakeStream())),
    },
  });
});
afterEach(() => vi.unstubAllGlobals());

// ---------------------------------------------------------------- recorder

describe("Recorder", () => {
  it("reports whether the browser can record", () => {
    expect(Recorder.supported()).toBe(true);
    vi.stubGlobal("navigator", {});
    expect(Recorder.supported()).toBe(false);
  });

  it("asks for the microphone and starts recording with a supported container", async () => {
    const r = new Recorder();
    await r.start();
    expect(r.active).toBe(true);
    expect(lastRecorder!.state).toBe("recording");
    expect(lastRecorder!.mimeType).toBe("audio/webm;codecs=opus");
  });

  it("explains a denied permission and a missing microphone in plain words", async () => {
    const gum = navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>;
    gum.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotAllowedError" }));
    await expect(new Recorder().start()).rejects.toThrow(/permission/i);
    gum.mockRejectedValueOnce(Object.assign(new Error("x"), { name: "NotFoundError" }));
    await expect(new Recorder().start()).rejects.toThrow(/no microphone/i);
    gum.mockRejectedValueOnce(new Error("weird"));
    await expect(new Recorder().start()).rejects.toThrow(/weird/);
  });

  it("stop() returns every recorded part as one blob and releases the microphone", async () => {
    const r = new Recorder();
    await r.start();
    const blob = await r.stop();
    expect(blob.size).toBe(5);
    expect(blob.type).toBe("audio/webm;codecs=opus");
    expect(lastStream!.tracks.every((t) => t.stopped)).toBe(true);
    expect(contexts[0]!.closed).toBe(true);
    expect(r.active).toBe(false);
  });

  it("stop() when not recording rejects instead of hanging", async () => {
    await expect(new Recorder().stop()).rejects.toThrow(/not recording/i);
  });

  it("cancel() releases the microphone without producing audio and allows a fresh start", async () => {
    const r = new Recorder();
    await r.start();
    r.cancel();
    expect(lastStream!.tracks.every((t) => t.stopped)).toBe(true);
    expect(r.active).toBe(false);
    await r.start();
    expect(r.active).toBe(true);
  });

  it("start() twice does not open a second microphone", async () => {
    const r = new Recorder();
    await r.start();
    await r.start();
    expect((navigator.mediaDevices.getUserMedia as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
  });

  it("level() follows the microphone signal and is 0 when idle", async () => {
    const r = new Recorder();
    expect(r.level()).toBe(0);
    await r.start();
    analyserValue = 128;
    expect(r.level()).toBe(0);
    analyserValue = 200;
    expect(r.level()).toBeGreaterThan(0.3);
    expect(r.level()).toBeLessThanOrEqual(1);
    r.cancel();
    expect(r.level()).toBe(0);
  });

  it("calls onLimit once when the maximum duration is reached", async () => {
    vi.useFakeTimers();
    const onLimit = vi.fn();
    const r = new Recorder({ maxMs: 5000, onLimit });
    await r.start();
    vi.advanceTimersByTime(4999);
    expect(onLimit).not.toHaveBeenCalled();
    vi.advanceTimersByTime(2);
    expect(onLimit).toHaveBeenCalledTimes(1);
    vi.useRealTimers();
  });

  it("still releases the microphone if the recorder cannot be created", async () => {
    vi.stubGlobal("MediaRecorder", class {
      static isTypeSupported() {
        return true;
      }
      constructor() {
        throw new Error("no recorder for you");
      }
    });
    await expect(new Recorder().start()).rejects.toThrow(/no recorder/);
    expect(lastStream!.tracks.every((t) => t.stopped)).toBe(true);
  });
});

// ---------------------------------------------------------------- player

describe("AudioPlayer", () => {
  it("reassembles chunks that arrive out of order and plays the clip after the last one", async () => {
    const p = new AudioPlayer();
    p.enqueue(chunk("a", 1, true, [3, 4]));
    expect(contexts).toHaveLength(0);
    p.enqueue(chunk("a", 0, false, [1, 2]));
    await tick();
    expect([...new Uint8Array(contexts[0]!.decoded[0]!)]).toEqual([1, 2, 3, 4]);
    expect(contexts[0]!.sources[0]!.started).toBe(true);
    expect(p.playing()).toBe(true);
  });

  it("does not start a clip until every chunk has arrived", async () => {
    const p = new AudioPlayer();
    p.enqueue(chunk("a", 0, false, [1]));
    p.enqueue(chunk("a", 2, true, [3]));
    await tick();
    expect(p.playing()).toBe(false);
    p.enqueue(chunk("a", 1, false, [2]));
    await tick();
    expect(p.playing()).toBe(true);
  });

  it("plays clips one after another and reports when it falls silent", async () => {
    const p = new AudioPlayer();
    const changes: boolean[] = [];
    p.onChange((v) => changes.push(v));
    p.enqueue(chunk("a", 0, true, [1]));
    p.enqueue(chunk("b", 0, true, [2]));
    await tick();
    const ctx = contexts[0]!;
    expect(ctx.sources).toHaveLength(1); // the second waits for the first
    ctx.sources[0]!.onended!();
    await tick();
    expect(ctx.sources).toHaveLength(2);
    expect(p.playing()).toBe(true);
    ctx.sources[1]!.onended!();
    await tick();
    expect(p.playing()).toBe(false);
    expect(changes).toEqual([true, false]);
  });

  it("stop() halts the current clip, empties the queue and drops half-received clips", async () => {
    const p = new AudioPlayer();
    p.enqueue(chunk("a", 0, true, [1]));
    p.enqueue(chunk("b", 0, true, [2]));
    p.enqueue(chunk("c", 0, false, [3]));
    await tick();
    p.stop();
    expect(contexts[0]!.sources[0]!.stopped).toBe(true);
    expect(p.playing()).toBe(false);
    await tick();
    expect(contexts[0]!.sources).toHaveLength(1); // "b" never starts
    p.enqueue(chunk("c", 1, true, [4]));
    await tick();
    expect(p.playing()).toBe(false); // the stopped clip "c" does not resurrect
  });

  it("skips a clip that cannot be decoded and plays the next", async () => {
    const p = new AudioPlayer();
    p.unlock();
    contexts[0]!.failDecodeFor = [1];
    p.enqueue(chunk("bad", 0, true, [9]));
    p.enqueue(chunk("good", 0, true, [1]));
    await tick();
    await tick();
    expect(contexts[0]!.sources).toHaveLength(1);
    expect(p.playing()).toBe(true);
  });

  it("level() is 0 when idle and reflects the output while playing", async () => {
    const p = new AudioPlayer();
    expect(p.level()).toBe(0);
    p.enqueue(chunk("a", 0, true, [1]));
    await tick();
    analyserValue = 128;
    expect(p.level()).toBe(0);
    analyserValue = 210;
    expect(p.level()).toBeGreaterThan(0.3);
    p.stop();
    expect(p.level()).toBe(0);
  });

  it("unlock() creates and resumes the audio context from a user gesture", async () => {
    const p = new AudioPlayer();
    p.unlock();
    expect(contexts).toHaveLength(1);
    contexts[0]!.state = "suspended";
    p.unlock();
    await tick();
    expect(contexts[0]!.state).toBe("running");
    expect(contexts).toHaveLength(1);
  });

  it("ignores malformed base64 without throwing", async () => {
    const p = new AudioPlayer();
    expect(() => p.enqueue({ id: "x", seq: 0, last: true, mime: "audio/wav", data: "!!!not base64!!!" })).not.toThrow();
    await tick();
  });
});
