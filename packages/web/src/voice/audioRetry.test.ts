import { afterEach, describe, expect, it, vi } from "vitest";
import { captureSession, isSessionError, watchCapture } from "./audioSession";
import { Recorder } from "./recorder";

class FakeMediaRecorder {
  static isTypeSupported = () => true;
  state = "inactive";
  mimeType = "audio/mp4";
  ondataavailable: unknown = null;
  onstop: unknown = null;
  onerror: unknown = null;
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("the microphone on an iPhone that still reports the old audio mode", () => {
  it("recognises the error", () => {
    expect(isSessionError(new Error("AudioSession category is not compatible with audio capture"))).toBe(true);
    expect(isSessionError({ name: "NotAllowedError", message: "denied" })).toBe(false);
  });

  it("tries once more after a moment, and then records", async () => {
    const gum = vi
      .fn()
      .mockRejectedValueOnce(new Error("AudioSession category is not compatible with audio capture"))
      .mockResolvedValue({ getTracks: () => [{ stop() {}, onended: null }] });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: gum }, audioSession: { type: "playback" } });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    const rec = new Recorder();
    await rec.start();
    expect(gum).toHaveBeenCalledTimes(2);
    expect(rec.active).toBe(true);
    rec.cancel();
  });

  it("does not retry a refusal by the person", async () => {
    const gum = vi.fn().mockRejectedValue({ name: "NotAllowedError", message: "no" });
    vi.stubGlobal("navigator", { mediaDevices: { getUserMedia: gum } });
    vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
    await expect(new Recorder().start()).rejects.toThrow(/permission/i);
    expect(gum).toHaveBeenCalledTimes(1);
  });

  it("tells watchers (the player) when the microphone opens and closes", () => {
    const seen: boolean[] = [];
    const off = watchCapture((on) => seen.push(on));
    const leave = captureSession();
    const leave2 = captureSession();
    leave();
    leave2();
    off();
    expect(seen).toEqual([true, false]);
  });
});
