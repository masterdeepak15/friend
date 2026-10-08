import type { ClientMsg } from "@friend/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalAction } from "../store";
import { VoiceController } from "./controller";
import { AudioPlayer } from "./player";
import { Recorder } from "./recorder";

// ------------------------------------------------------------ browser fakes

class Track {
  onended: (() => void) | null = null;
  stopped = false;
  stop() {
    this.stopped = true;
  }
}
class Stream {
  tracks = [new Track()];
  getTracks() {
    return this.tracks;
  }
}
let stream: Stream | null = null;
let mr: MR | null = null;
let contexts: Ctx[] = [];

class MR {
  static isTypeSupported() {
    return true;
  }
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/webm";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: ((e: unknown) => void) | null = null;
  stopThrows = false;
  neverStops = false;
  constructor(public s: Stream, opts?: { mimeType?: string }) {
    this.mimeType = opts?.mimeType ?? "audio/webm";
    mr = this;
  }
  start() {
    this.state = "recording";
  }
  stop() {
    if (this.stopThrows) throw new Error("InvalidStateError");
    if (this.neverStops) return;
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array([1, 2, 3])]) });
    this.onstop?.();
  }
}
class Analyser {
  fftSize = 0;
  getByteTimeDomainData(a: Uint8Array) {
    a.fill(128);
  }
  connect() {}
}
class Src {
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
class Ctx {
  state = "running";
  destination = {};
  sources: Src[] = [];
  closed = false;
  keepSuspended = false;
  constructor() {
    contexts.push(this);
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  createAnalyser() {
    return new Analyser();
  }
  createBufferSource() {
    const s = new Src();
    this.sources.push(s);
    return s;
  }
  async decodeAudioData() {
    return { duration: 1 };
  }
  async resume() {
    if (!this.keepSuspended) this.state = "running";
  }
  async close() {
    this.closed = true;
  }
}

const b64 = (bytes: number[]) => Buffer.from(bytes).toString("base64");
const chunk = (id: string, seq: number, last: boolean, bytes: number[]) => ({ id, seq, last, mime: "audio/wav", data: b64(bytes) });
const tick = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  stream = null;
  mr = null;
  contexts = [];
  vi.stubGlobal("MediaRecorder", MR);
  vi.stubGlobal("AudioContext", Ctx);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => (stream = new Stream())) } });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ------------------------------------------------------------ recorder

describe("Recorder resilience", () => {
  it("stop() resolves with what was recorded even if the recorder already went inactive", async () => {
    const r = new Recorder();
    await r.start();
    mr!.state = "inactive";
    mr!.neverStops = true;
    await expect(r.stop()).resolves.toBeInstanceOf(Blob);
    expect(r.active).toBe(false);
    expect(stream!.tracks.every((t) => t.stopped)).toBe(true);
  });

  it("stop() resolves if the browser throws from MediaRecorder.stop()", async () => {
    const r = new Recorder();
    await r.start();
    mr!.stopThrows = true;
    await expect(r.stop()).resolves.toBeInstanceOf(Blob);
    expect(r.active).toBe(false);
  });

  it("stop() gives up waiting for a recorder that never reports it stopped", async () => {
    vi.useFakeTimers();
    const r = new Recorder();
    await r.start();
    mr!.neverStops = true;
    const pending = r.stop();
    await vi.advanceTimersByTimeAsync(3500);
    await expect(pending).resolves.toBeInstanceOf(Blob);
    expect(r.active).toBe(false);
  });

  it("reports a recorder error and a microphone that disappears, and releases the device", async () => {
    const onError = vi.fn();
    const r = new Recorder({ onError });
    await r.start();
    mr!.onerror?.({});
    expect(onError).toHaveBeenCalledTimes(1);
    expect(r.active).toBe(false);
    expect(stream!.tracks.every((t) => t.stopped)).toBe(true);

    const r2 = new Recorder({ onError });
    await r2.start();
    stream!.tracks[0]!.onended?.();
    expect(onError).toHaveBeenCalledTimes(2);
    expect(r2.active).toBe(false);
  });
});

// ------------------------------------------------------------ player

describe("AudioPlayer limits and safety", () => {
  it("ignores chunks with an invalid sequence number", async () => {
    const p = new AudioPlayer();
    p.enqueue(chunk("a", -1, true, [1]));
    p.enqueue(chunk("a", 1.5, true, [1]));
    p.enqueue(chunk("a", 999_999, true, [1]));
    await tick();
    expect(p.playing()).toBe(false);
    expect(contexts).toHaveLength(0);
  });

  it("keeps only a bounded number of half-received clips", async () => {
    const p = new AudioPlayer();
    for (let i = 0; i < 40; i++) p.enqueue(chunk(`stuck-${i}`, 0, false, [1]));
    p.enqueue(chunk("stuck-0", 1, true, [2])); // the oldest was evicted: it can no longer complete
    await tick();
    expect(p.playing()).toBe(false);
    p.enqueue(chunk("stuck-39", 1, true, [2])); // a recent one still completes
    await tick();
    expect(p.playing()).toBe(true);
  });

  it("drops a clip that grows past the size limit", async () => {
    const p = new AudioPlayer();
    const big = Array.from({ length: 1_000_000 }, () => 7);
    for (let seq = 0; seq < 8; seq++) p.enqueue(chunk("huge", seq, false, big));
    p.enqueue(chunk("huge", 8, true, [1]));
    await tick();
    expect(p.playing()).toBe(false);
  });

  it("bounds the playback queue", async () => {
    const p = new AudioPlayer();
    p.unlock();
    contexts[0]!.keepSuspended = true;
    contexts[0]!.state = "suspended";
    for (let i = 0; i < 60; i++) p.enqueue(chunk(`c${i}`, 0, true, [1]));
    await tick();
    contexts[0]!.keepSuspended = false;
    contexts[0]!.state = "running";
    p.enqueue(chunk("last", 0, true, [1]));
    await tick();
    let played = 0;
    while (contexts[0]!.sources[played]) {
      contexts[0]!.sources[played]!.onended?.();
      played++;
      await tick();
    }
    expect(played).toBeLessThanOrEqual(25);
  });

  it("does not claim to be playing on an audio context that cannot start", async () => {
    const p = new AudioPlayer();
    p.unlock();
    contexts[0]!.state = "suspended";
    contexts[0]!.keepSuspended = true;
    p.enqueue(chunk("a", 0, true, [1]));
    await tick();
    await tick();
    expect(p.playing()).toBe(false);
    expect(contexts[0]!.sources).toHaveLength(0);
  });

  it("dispose() stops playback and closes the audio context", async () => {
    const p = new AudioPlayer();
    p.enqueue(chunk("a", 0, true, [1]));
    await tick();
    p.dispose();
    expect(contexts[0]!.closed).toBe(true);
    expect(p.playing()).toBe(false);
  });
});

// ------------------------------------------------------------ controller

class FakeRec {
  active = false;
  cancelled = 0;
  async start() {
    this.active = true;
  }
  async stop() {
    this.active = false;
    return new Blob([new Uint8Array(20_000)], { type: "audio/webm" });
  }
  cancel() {
    this.active = false;
    this.cancelled++;
  }
  level() {
    return 0.5;
  }
}
class FakePlayer {
  isPlaying = false;
  disposed = 0;
  cb: ((p: boolean) => void) | null = null;
  playing() {
    return this.isPlaying;
  }
  stop() {
    this.isPlaying = false;
  }
  unlock() {}
  enqueue() {}
  dispose() {
    this.disposed++;
  }
  onChange(cb: (p: boolean) => void) {
    this.cb = cb;
    return () => (this.cb = null);
  }
  level() {
    return 0.2;
  }
}

describe("VoiceController re-pressing and robustness", () => {
  let rec: FakeRec;
  let player: FakePlayer;
  let actions: LocalAction[];
  let post: ReturnType<typeof vi.fn<(audio: Blob, signal?: AbortSignal) => Promise<{ text: string }>>>;
  let ctl: VoiceController;
  const modes = () => actions.filter((a) => a.type === "voice.mode").map((a) => (a as { mode: string }).mode);
  const alerts = () => actions.filter((a) => a.type === "alert.add") as { text: string }[];
  const flush = () => new Promise((r) => setTimeout(r, 0));

  beforeEach(() => {
    rec = new FakeRec();
    player = new FakePlayer();
    actions = [];
    post = vi.fn(async () => ({ text: "hello" }));
    ctl = new VoiceController({
      send: (_m: ClientMsg) => {},
      dispatch: (a) => actions.push(a),
      recorder: rec as never,
      player: player as never,
      post,
      available: () => true,
      supported: () => true,
    });
  });
  afterEach(() => ctl.dispose());

  it("keeps showing listening when the owner presses again while the first recording is still being transcribed", async () => {
    let answer!: (v: { text: string }) => void;
    post.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    await ctl.pressStart();
    const first = ctl.pressEnd();
    await flush();
    expect(modes().at(-1)).toBe("transcribing");
    await ctl.pressStart(); // talk again before the first transcript returns
    expect(modes().at(-1)).toBe("listening");
    expect(rec.active).toBe(true);
    answer({ text: "hello" }); // the old upload finishes late
    await first;
    expect(modes().at(-1)).toBe("listening"); // it must not hide the open microphone
    expect(rec.active).toBe(true);
  });

  it("does not clobber a newer recording when the old upload fails", async () => {
    let fail!: (e: Error) => void;
    post.mockImplementationOnce(() => new Promise((_r, rej) => (fail = rej)));
    await ctl.pressStart();
    const first = ctl.pressEnd();
    await flush();
    await ctl.pressStart();
    fail(new Error("boom"));
    await first;
    expect(modes().at(-1)).toBe("listening");
  });

  it("shows speaking, not idle, when the reply is already playing as the transcript finishes", async () => {
    await ctl.pressStart();
    let answer!: (v: { text: string }) => void;
    post.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    const done = ctl.pressEnd();
    await flush();
    player.isPlaying = true;
    player.cb?.(true); // ignored while transcribing
    answer({ text: "hi" });
    await done;
    expect(modes().at(-1)).toBe("speaking");
  });

  it("ends the recording and says so when the recorder fails by itself (device unplugged)", async () => {
    let onError!: () => void;
    const c = new VoiceController({
      send: () => {},
      dispatch: (a) => actions.push(a),
      player: player as never,
      post,
      available: () => true,
      supported: () => true,
      makeRecorder: (cb) => {
        onError = cb;
        return rec as never;
      },
    });
    await c.pressStart();
    onError();
    expect(rec.cancelled).toBeGreaterThan(0);
    expect(modes().at(-1)).toBe("idle");
    expect(alerts().at(-1)!.text).toMatch(/microphone/i);
    c.dispose();
  });

  it("aborts an upload that is still in flight when the controller is disposed, without alarming the owner", async () => {
    let signal: AbortSignal | undefined;
    post.mockImplementationOnce(
      (_b: Blob, s?: AbortSignal) =>
        new Promise((_r, rej) => {
          signal = s;
          s?.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })));
        }),
    );
    await ctl.pressStart();
    const done = ctl.pressEnd();
    await flush();
    ctl.dispose();
    await done;
    expect(signal?.aborted).toBe(true);
    expect(alerts()).toEqual([]);
  });

  it("disposes the player (closing its audio context)", () => {
    ctl.dispose();
    expect(player.disposed).toBe(1);
  });
});
