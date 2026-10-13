import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Listener } from "./listener";

class FakeTrack {
  stopped = false;
  onended: (() => void) | null = null;
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
let stream: FakeStream | null = null;
let recorders: FakeRecorder[] = [];
let sample = 128; // 128 = silence; the analyser reads this
class FakeRecorder {
  static isTypeSupported() {
    return true;
  }
  state = "inactive";
  mimeType = "audio/webm;codecs=opus";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public stream: unknown) {
    recorders.push(this);
  }
  start() {
    this.state = "recording";
    this.ondataavailable?.({ data: new Blob([new Uint8Array(500)]) });
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob([new Uint8Array(500)]) });
    queueMicrotask(() => this.onstop?.());
  }
}
class FakeAnalyser {
  fftSize = 0;
  getByteTimeDomainData(a: Uint8Array) {
    // a square wave around 128, so the level is easy to control: |sample - 128| / 128 * 4
    a.forEach((_, i) => (a[i] = i % 2 ? sample : 256 - sample));
  }
}
let contexts: FakeAudioContext[] = [];
class FakeAudioContext {
  closed = false;
  state = "suspended"; // a browser starts the meter suspended until it is allowed to make sound
  resumed = 0;
  constructor() {
    contexts.push(this);
  }
  async resume() {
    this.resumed++;
    this.state = "running";
  }
  createMediaStreamSource() {
    return { connect() {} };
  }
  createAnalyser() {
    return new FakeAnalyser();
  }
  async close() {
    this.closed = true;
  }
}

let clock = 0;
const loud = () => (sample = 128 + 30); // level ≈ 0.94 (loud), far above the room
const quiet = () => (sample = 128);
/** Advance the fake clock and the 50 ms poll. */
async function advance(ms: number) {
  for (let i = 0; i < ms / 50; i++) {
    clock += 50;
    await vi.advanceTimersByTimeAsync(50);
  }
}

let heard: Blob[];
let errors: string[];
const make = () => new Listener({ onUtterance: (b) => heard.push(b), onError: (m) => errors.push(m), now: () => clock });

beforeEach(() => {
  vi.useFakeTimers();
  clock = 0;
  stream = null;
  recorders = [];
  contexts = [];
  heard = [];
  errors = [];
  quiet();
  vi.stubGlobal("MediaRecorder", FakeRecorder);
  vi.stubGlobal("AudioContext", FakeAudioContext);
  vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => (stream = new FakeStream())) } });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("listening all the time", () => {
  it("asks for the microphone with the browser's own noise handling", async () => {
    const l = make();
    await l.start();
    expect(navigator.mediaDevices.getUserMedia).toHaveBeenCalledWith({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    expect(l.listening).toBe(true);
    l.stop();
  });

  it("hands over one recording for each thing said, and keeps listening", async () => {
    const l = make();
    await l.start();
    await advance(1000);
    loud();
    await advance(1200);
    quiet();
    await advance(1200);
    expect(heard).toHaveLength(1);
    expect(heard[0]!.size).toBeGreaterThan(0);
    expect(l.listening).toBe(true);
    expect(recorders.at(-1)!.state).toBe("recording"); // a fresh one is already running
    loud();
    await advance(1200);
    quiet();
    await advance(1200);
    expect(heard).toHaveLength(2);
    l.stop();
  });

  it("sends nothing for silence or a click", async () => {
    const l = make();
    await l.start();
    await advance(5000);
    loud();
    await advance(150);
    quiet();
    await advance(3000);
    expect(heard).toHaveLength(0);
    l.stop();
  });

  it("restarts its short recording while nobody speaks, so it never grows", async () => {
    const l = make();
    await l.start();
    await advance(7000);
    expect(recorders.length).toBeGreaterThanOrEqual(3);
    expect(recorders.slice(0, -1).every((r) => r.state === "inactive")).toBe(true);
    l.stop();
  });

  it("collects nothing while paused, and starts clean when it resumes", async () => {
    const l = make();
    await l.start();
    await advance(500);
    l.pause(true);
    loud();
    await advance(1500);
    quiet();
    await advance(1500);
    expect(heard).toHaveLength(0);
    l.pause(false);
    await advance(500);
    loud();
    await advance(1200);
    quiet();
    await advance(1200);
    expect(heard).toHaveLength(1);
    l.stop();
  });

  it("releases the microphone when stopped", async () => {
    const l = make();
    await l.start();
    l.stop();
    expect(stream!.tracks[0]!.stopped).toBe(true);
    expect(l.listening).toBe(false);
    await advance(3000);
    expect(heard).toHaveLength(0);
  });

  it("says so, and lets go, when the microphone is unplugged", async () => {
    const l = make();
    await l.start();
    stream!.tracks[0]!.onended?.();
    expect(errors).toEqual(["The microphone stopped working."]);
    expect(l.listening).toBe(false);
  });

  it("explains a refused microphone", async () => {
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: vi.fn(async () => Promise.reject(Object.assign(new Error("x"), { name: "NotAllowedError" }))) } });
    await expect(make().start()).rejects.toThrow(/permission was denied/);
  });

  it("wakes the audio meter, because a suspended one hears only silence", async () => {
    const l = make();
    await l.start();
    expect(contexts[0]!.resumed).toBeGreaterThanOrEqual(1);
    l.stop();
  });

  it("wakes it again if the browser suspends it later", async () => {
    const l = make();
    await l.start();
    contexts[0]!.state = "suspended";
    const before = contexts[0]!.resumed;
    await advance(200);
    expect(contexts[0]!.resumed).toBeGreaterThan(before);
    l.stop();
  });
});
