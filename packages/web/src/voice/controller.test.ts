import type { ClientMsg } from "@friend/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalAction } from "../store";
import { VoiceController } from "./controller";

class FakeRecorder {
  active = false;
  startCalls = 0;
  cancelled = 0;
  blobSize = 20_000;
  startGate: Promise<void> | null = null;
  startError: Error | null = null;
  levelValue = 0.5;
  async start() {
    this.startCalls++;
    if (this.startGate) await this.startGate;
    if (this.startError) throw this.startError;
    this.active = true;
  }
  async stop() {
    this.active = false;
    return new Blob([new Uint8Array(this.blobSize)], { type: "audio/webm" });
  }
  cancel() {
    this.active = false;
    this.cancelled++;
  }
  level() {
    return this.levelValue;
  }
}

class FakePlayer {
  isPlaying = false;
  stopped = 0;
  unlocked = 0;
  chunks: unknown[] = [];
  cb: ((p: boolean) => void) | null = null;
  levelValue = 0.3;
  playing() {
    return this.isPlaying;
  }
  stop() {
    this.stopped++;
    this.isPlaying = false;
  }
  unlock() {
    this.unlocked++;
  }
  enqueue(c: unknown) {
    this.chunks.push(c);
  }
  onChange(cb: (p: boolean) => void) {
    this.cb = cb;
    return () => (this.cb = null);
  }
  level() {
    return this.levelValue;
  }
  emit(p: boolean) {
    this.isPlaying = p;
    this.cb?.(p);
  }
}

let rec: FakeRecorder;
let player: FakePlayer;
let sent: ClientMsg[];
let actions: LocalAction[];
let post: ReturnType<typeof vi.fn<(audio: Blob) => Promise<{ text: string }>>>;
let available = true;
let ctl: VoiceController;

const modes = () => actions.filter((a) => a.type === "voice.mode").map((a) => (a as { mode: string }).mode);
const alerts = () => actions.filter((a) => a.type === "alert.add") as { type: "alert.add"; level: string; text: string }[];
const flush = () => new Promise((r) => setTimeout(r, 0));

beforeEach(() => {
  rec = new FakeRecorder();
  player = new FakePlayer();
  sent = [];
  actions = [];
  available = true;
  post = vi.fn(async () => ({ text: "hello" }));
  ctl = new VoiceController({
    send: (m) => sent.push(m),
    dispatch: (a) => actions.push(a),
    recorder: rec as never,
    player: player as never,
    post,
    available: () => available,
    supported: () => true,
  });
});
afterEach(() => {
  ctl.dispose();
  vi.useRealTimers();
});

describe("VoiceController push to talk", () => {
  it("tells the owner when voice is unavailable and does not record", async () => {
    available = false;
    await ctl.pressStart();
    expect(rec.startCalls).toBe(0);
    expect(alerts()[0]).toMatchObject({ level: "warn" });
    expect(alerts()[0]!.text).toMatch(/voice is not available/i);
  });

  it("starts one recording however many key-repeat presses arrive, and unlocks audio", async () => {
    await Promise.all([ctl.pressStart(), ctl.pressStart(), ctl.pressStart()]);
    expect(rec.startCalls).toBe(1);
    expect(player.unlocked).toBeGreaterThan(0);
    expect(modes()).toEqual(["listening"]);
  });

  it("on release stops, posts the audio once, shows transcribing, then returns to idle", async () => {
    let answer!: (v: { text: string }) => void;
    post.mockImplementationOnce(() => new Promise((r) => (answer = r)));
    await ctl.pressStart();
    const done = ctl.pressEnd();
    await flush();
    expect(modes()).toEqual(["listening", "transcribing"]); // still waiting for the transcript
    answer({ text: "hello" });
    await done;
    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0]![0] as Blob).size).toBe(20_000);
    expect(modes().at(-1)).toBe("idle");
  });

  it("ignores a release with no press and a second release", async () => {
    await ctl.pressEnd();
    await ctl.pressStart();
    await ctl.pressEnd();
    await ctl.pressEnd();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it("does not post a recording that is too short and says so", async () => {
    rec.blobSize = 200;
    await ctl.pressStart();
    await ctl.pressEnd();
    expect(post).not.toHaveBeenCalled();
    expect(alerts()[0]!.text).toMatch(/longer/i);
    expect(modes().at(-1)).toBe("idle");
  });

  it("reports a failed upload and a transcript with nothing in it", async () => {
    post.mockRejectedValueOnce(new Error("Voice is not available"));
    await ctl.pressStart();
    await ctl.pressEnd();
    expect(alerts().at(-1)).toMatchObject({ level: "error", text: "Voice is not available" });
    post.mockResolvedValueOnce({ text: "" });
    await ctl.pressStart();
    await ctl.pressEnd();
    expect(alerts().at(-1)!.text).toMatch(/didn't catch/i);
    expect(modes().at(-1)).toBe("idle");
  });

  it("shows the microphone error and stays idle when permission is denied", async () => {
    rec.startError = new Error("Microphone permission was denied.");
    await ctl.pressStart();
    expect(alerts().at(-1)).toMatchObject({ level: "error", text: "Microphone permission was denied." });
    expect(modes().at(-1)).toBe("idle");
  });

  it("closes the microphone if the key is released while the permission prompt is still open", async () => {
    let open!: () => void;
    rec.startGate = new Promise<void>((r) => (open = r));
    const starting = ctl.pressStart();
    await ctl.pressEnd(); // released before the microphone opened
    open();
    await starting;
    expect(rec.active).toBe(false);
    expect(rec.cancelled).toBeGreaterThan(0);
    expect(post).not.toHaveBeenCalled();
    expect(modes().at(-1)).toBe("idle");
  });

  it("loses focus while held: the recording is thrown away and nothing is sent", async () => {
    await ctl.pressStart();
    ctl.blur();
    expect(rec.cancelled).toBe(1);
    expect(rec.active).toBe(false);
    await ctl.pressEnd();
    expect(post).not.toHaveBeenCalled();
    expect(modes().at(-1)).toBe("idle");
  });

  it("interrupts speech when the owner starts talking (barge-in)", async () => {
    player.isPlaying = true;
    await ctl.pressStart();
    expect(sent).toContainEqual({ type: "voice.interrupt" });
    expect(player.stopped).toBeGreaterThan(0);
  });

  it("does not send an interrupt when nothing is playing", async () => {
    await ctl.pressStart();
    expect(sent).toEqual([]);
  });

  it("polls the microphone level while listening and stops polling afterwards", async () => {
    vi.useFakeTimers();
    await ctl.pressStart();
    rec.levelValue = 0.7;
    vi.advanceTimersByTime(200);
    const levels = actions.filter((a) => a.type === "voice.level");
    expect(levels.length).toBeGreaterThanOrEqual(3);
    expect((levels.at(-1) as { level: number }).level).toBe(0.7);
    await ctl.pressEnd();
    const count = actions.filter((a) => a.type === "voice.level").length;
    vi.advanceTimersByTime(500);
    expect(actions.filter((a) => a.type === "voice.level").length).toBe(count);
  });
});

describe("VoiceController playback", () => {
  it("hands audio chunks to the player and stops it on audio.stop", () => {
    const chunk = { type: "audio.chunk" as const, id: "1-0", seq: 0, last: true, mime: "audio/wav", data: "AA==" };
    ctl.handleServer(chunk);
    expect(player.chunks).toEqual([chunk]);
    ctl.handleServer({ type: "audio.stop" });
    expect(player.stopped).toBe(1);
  });

  it("shows speaking while audio plays and idle when it ends", () => {
    player.emit(true);
    expect(modes()).toEqual(["speaking"]);
    player.emit(false);
    expect(modes()).toEqual(["speaking", "idle"]);
  });

  it("does not let speech override listening", async () => {
    await ctl.pressStart();
    actions.length = 0;
    player.emit(true);
    player.emit(false);
    expect(modes()).toEqual([]);
  });

  it("polls the playback level while speaking", () => {
    vi.useFakeTimers();
    player.levelValue = 0.9;
    player.emit(true);
    vi.advanceTimersByTime(120);
    const levels = actions.filter((a) => a.type === "voice.level") as { level: number }[];
    expect(levels.length).toBeGreaterThanOrEqual(2);
    expect(levels.at(-1)!.level).toBe(0.9);
  });

  it("dispose() releases the microphone and stops playback", async () => {
    await ctl.pressStart();
    ctl.dispose();
    expect(rec.active).toBe(false);
    expect(player.stopped).toBeGreaterThan(0);
  });
});

describe("keeping quiet", () => {
  const clip = { type: "audio.chunk" as const, id: "1-0", seq: 0, last: true, mime: "audio/wav", data: "AA==" };

  it("silences a reply that is being spoken and plays nothing more while quiet", () => {
    ctl.handleServer(clip);
    expect(player.chunks).toHaveLength(1);
    const stopped = player.stopped;
    ctl.setQuiet(true);
    expect(player.stopped).toBeGreaterThan(stopped);
    ctl.handleServer({ ...clip, id: "2-0" });
    expect(player.chunks).toHaveLength(1);
  });

  it("speaks again once the voice is back on", () => {
    ctl.setQuiet(true);
    ctl.setQuiet(false);
    ctl.handleServer(clip);
    expect(player.chunks).toHaveLength(1);
  });
});
