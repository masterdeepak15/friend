import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { captureSession, playbackSession } from "./audioSession";
import { Recorder } from "./recorder";

/** A phone's audio session that, like iPhone Safari, refuses to record while it is "playback". */
function phone() {
  const session = { type: "auto", history: [] as string[] };
  const proxy = {
    get type() {
      return session.type;
    },
    set type(v: string) {
      session.type = v;
      session.history.push(v);
    },
  };
  return { session, proxy };
}

class FakeMediaRecorder {
  static isTypeSupported = () => true;
  state: "inactive" | "recording" = "inactive";
  mimeType = "audio/mp4";
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public stream: unknown) {}
  start() {
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.ondataavailable?.({ data: new Blob(["a"]) });
    this.onstop?.();
  }
}

let ph: ReturnType<typeof phone>;
beforeEach(() => {
  ph = phone();
});
afterEach(() => vi.unstubAllGlobals());

const stubNavigator = (getUserMedia: () => Promise<unknown>) => {
  vi.stubGlobal("navigator", { audioSession: ph.proxy, mediaDevices: { getUserMedia } });
  vi.stubGlobal("MediaRecorder", FakeMediaRecorder);
};
const stream = () => ({ getTracks: () => [{ stop() {}, onended: null }] });

describe("the audio session on an iPhone", () => {
  it("plays through the silent switch while nothing is recording", () => {
    vi.stubGlobal("navigator", { audioSession: ph.proxy });
    playbackSession();
    expect(ph.session.type).toBe("playback");
  });

  it("switches to play-and-record while the microphone is open, then back to playback", () => {
    vi.stubGlobal("navigator", { audioSession: ph.proxy });
    playbackSession();
    const leave = captureSession();
    expect(ph.session.type).toBe("play-and-record");
    leave();
    expect(ph.session.type).toBe("playback");
  });

  it("does not drop back to playback in the middle of a recording (a tap elsewhere asks for sound)", () => {
    vi.stubGlobal("navigator", { audioSession: ph.proxy });
    const leave = captureSession();
    playbackSession();
    playbackSession();
    expect(ph.session.type).toBe("play-and-record");
    leave();
    expect(ph.session.type).toBe("playback");
  });

  it("stays in play-and-record until the last of two overlapping recordings ends, and ending one twice is harmless", () => {
    vi.stubGlobal("navigator", { audioSession: ph.proxy });
    const a = captureSession();
    const b = captureSession();
    a();
    a();
    expect(ph.session.type).toBe("play-and-record");
    b();
    expect(ph.session.type).toBe("playback");
  });

  it("does nothing, and does not fail, on a browser without an audio session or one that refuses the setting", () => {
    vi.stubGlobal("navigator", {});
    expect(() => captureSession()()).not.toThrow();
    expect(() => playbackSession()).not.toThrow();
    vi.stubGlobal("navigator", {
      audioSession: {
        get type() {
          return "auto";
        },
        set type(_v: string) {
          throw new Error("not allowed");
        },
      },
    });
    expect(() => captureSession()()).not.toThrow();
  });
});

describe("the recorder and the audio session", () => {
  it("asks for the microphone only after the session allows recording, which is the iPhone error", async () => {
    let typeWhenAsked = "";
    stubNavigator(async () => {
      typeWhenAsked = ph.session.type;
      if (typeWhenAsked === "playback") throw Object.assign(new Error("AudioSession category is not compatible with audio capture."), { name: "NotAllowedError" });
      return stream();
    });
    playbackSession(); // the first tap on the page already asked for sound
    expect(ph.session.type).toBe("playback");
    const rec = new Recorder();
    await rec.start();
    expect(typeWhenAsked).toBe("play-and-record");
    expect(rec.active).toBe(true);
    await rec.stop();
    expect(ph.session.type).toBe("playback"); // and sound plays through the silent switch again
  });

  it("puts the session back when the microphone is refused", async () => {
    stubNavigator(async () => {
      throw Object.assign(new Error("denied"), { name: "NotAllowedError" });
    });
    await expect(new Recorder().start()).rejects.toThrow(/permission/i);
    expect(ph.session.type).toBe("playback");
  });

  it("puts the session back when a recording is cancelled", async () => {
    stubNavigator(async () => stream());
    const rec = new Recorder();
    await rec.start();
    expect(ph.session.type).toBe("play-and-record");
    rec.cancel();
    expect(ph.session.type).toBe("playback");
  });
});
