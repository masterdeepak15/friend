import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { HandsFree } from "./handsfree";

const blob = (n = 1000) => new Blob([new Uint8Array(n)]);
const tick = () => vi.advanceTimersByTimeAsync(0);

let onUtterance: (b: Blob) => void;
let onError: (m: string) => void;
let listener: { start: Mock<() => Promise<void>>; stop: Mock<() => void>; pause: Mock<(on: boolean) => void>; level: Mock<() => number>; listening: boolean };
let wake: Mock<(audio: Blob, signal?: AbortSignal) => Promise<{ text: string; wake: boolean }>>;
let command: Mock<(audio: Blob, signal?: AbortSignal) => Promise<{ text: string }>>;
let chime: Mock<() => void>;
let actions: unknown[];
/** What the page's voice mode is. The test plays the part of the store: our own dispatches change it too. */
let mode: string;
let hf: HandsFree;

beforeEach(() => {
  vi.useFakeTimers();
  actions = [];
  mode = "idle";
  listener = { start: vi.fn(async () => void (listener.listening = true)), stop: vi.fn(() => void (listener.listening = false)), pause: vi.fn(), level: vi.fn(() => 0.5), listening: false };
  wake = vi.fn(async () => ({ text: "", wake: false }));
  command = vi.fn(async () => ({ text: "open it" }));
  chime = vi.fn();
  hf = new HandsFree({
    makeListener: (o) => {
      onUtterance = o.onUtterance;
      onError = o.onError;
      return listener;
    },
    wake,
    command,
    mode: () => mode,
    chime,
    dispatch: (a) => {
      actions.push(a);
      const m = (a as { type: string; mode?: string }).type === "voice.mode" ? (a as { mode: string }).mode : null;
      if (m) mode = m;
    },
    awakeMs: 30_000,
  });
});
afterEach(() => vi.useRealTimers());

const alerts = () => actions.filter((a) => (a as { type: string }).type === "alert.add");
const modes = () => actions.filter((a) => (a as { type: string }).type === "voice.mode").map((a) => (a as { mode: string }).mode);
const woken = async (text = "") => {
  wake.mockResolvedValueOnce({ text, wake: true });
  onUtterance(blob());
  await tick();
};

describe("starting and stopping", () => {
  it("starts and stops listening", async () => {
    await hf.enable();
    expect(listener.start).toHaveBeenCalled();
    expect(hf.enabled).toBe(true);
    hf.disable();
    expect(listener.stop).toHaveBeenCalled();
    expect(hf.enabled).toBe(false);
  });

  it("tells the owner when the microphone cannot be opened, and stays off", async () => {
    listener.start.mockRejectedValueOnce(new Error("Microphone permission was denied."));
    await hf.enable();
    expect(hf.enabled).toBe(false);
    expect(alerts()).toEqual([{ type: "alert.add", level: "error", text: "Microphone permission was denied." }]);
  });

  it("turns itself off, and says why, when the microphone stops", async () => {
    await hf.enable();
    onError("The microphone stopped working.");
    expect(hf.enabled).toBe(false);
    expect(alerts()).toEqual([{ type: "alert.add", level: "error", text: "The microphone stopped working." }]);
  });
});

describe("asleep: waiting for the name", () => {
  it("asks the server about each thing said, silently, and does nothing more when the name was not said", async () => {
    await hf.enable();
    onUtterance(blob());
    await tick();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(command).not.toHaveBeenCalled();
    expect(chime).not.toHaveBeenCalled();
    expect(modes()).toEqual([]); // no "Transcribing…" for every noise in the room
    expect(alerts()).toEqual([]);
  });

  it("stays asleep through noise: the next thing said is checked for the name again", async () => {
    await hf.enable();
    for (let i = 0; i < 3; i++) {
      onUtterance(blob());
      await tick();
    }
    expect(wake).toHaveBeenCalledTimes(3);
    expect(command).not.toHaveBeenCalled();
  });

  it("checks one thing at a time", async () => {
    let release!: (v: { text: string; wake: boolean }) => void;
    wake.mockImplementationOnce(() => new Promise((r) => (release = r)));
    await hf.enable();
    onUtterance(blob());
    onUtterance(blob());
    await tick();
    expect(wake).toHaveBeenCalledTimes(1);
    release({ text: "", wake: false });
    await tick();
  });

  it("ignores what is said while Friend is speaking or working", async () => {
    await hf.enable();
    mode = "speaking";
    onUtterance(blob());
    await tick();
    expect(wake).not.toHaveBeenCalled();
  });

  it("stays quiet about a busy or rate-limited server, but reports other failures once in a while", async () => {
    await hf.enable();
    wake.mockRejectedValueOnce(new Error("Friend is busy with the last request. Try again in a moment."));
    onUtterance(blob());
    await tick();
    wake.mockRejectedValueOnce(new Error("You're talking too fast. Wait a moment."));
    onUtterance(blob());
    await tick();
    expect(alerts()).toEqual([]);
    wake.mockRejectedValue(new Error("Could not reach Friend. Check the connection."));
    for (let i = 0; i < 3; i++) {
      onUtterance(blob());
      await tick();
    }
    expect(alerts()).toHaveLength(1);
  });
});

describe("awake: after the name, until 30 seconds pass with nothing said", () => {
  it("a request that came with the name is run by the server, and Friend stays awake with no chime", async () => {
    await hf.enable();
    await woken("what time is it");
    expect(chime).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
    expect(hf.awake).toBe(true);
    expect(mode).toBe("listening");
  });

  it("chimes when only the name was said, and stays awake", async () => {
    await hf.enable();
    await woken();
    expect(chime).toHaveBeenCalledTimes(1);
    expect(hf.awake).toBe(true);
    expect(modes()).toContain("listening");
  });

  it("then takes everything said as a request, without the name, again and again", async () => {
    await hf.enable();
    await woken();
    for (let i = 0; i < 3; i++) {
      mode = "listening"; // back to waiting after each answer
      onUtterance(blob());
      await tick();
    }
    expect(command).toHaveBeenCalledTimes(3);
    expect(wake).toHaveBeenCalledTimes(1);
    expect(hf.awake).toBe(true);
  });

  it("goes back to sleep after 30 seconds of nothing said, and needs the name again", async () => {
    await hf.enable();
    await woken();
    await vi.advanceTimersByTimeAsync(29_000);
    expect(hf.awake).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(hf.awake).toBe(false);
    expect(mode).toBe("idle");
    onUtterance(blob());
    await tick();
    expect(wake).toHaveBeenCalledTimes(2);
    expect(command).not.toHaveBeenCalled();
  });

  it("each request starts the 30 seconds again", async () => {
    await hf.enable();
    await woken();
    await vi.advanceTimersByTimeAsync(25_000);
    mode = "listening";
    onUtterance(blob());
    await tick();
    mode = "idle";
    hf.sync(); // Friend finished answering: waiting again
    await vi.advanceTimersByTimeAsync(25_000);
    expect(hf.awake).toBe(true);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(hf.awake).toBe(false);
  });

  it("does not run the clock while Friend is thinking or speaking: the 30 seconds start when it is quiet again", async () => {
    await hf.enable();
    await woken("tell me a long story");
    mode = "speaking";
    hf.sync();
    await vi.advanceTimersByTimeAsync(120_000);
    expect(hf.awake).toBe(true); // still its turn
    mode = "idle";
    hf.sync();
    expect(mode).toBe("listening"); // shows that it is waiting for the answer
    await vi.advanceTimersByTimeAsync(29_000);
    expect(hf.awake).toBe(true);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(hf.awake).toBe(false);
  });

  it("hears the answer to a question Friend asked, up to 30 seconds after it finished speaking", async () => {
    await hf.enable();
    await woken("book a table");
    mode = "speaking";
    hf.sync();
    mode = "idle";
    hf.sync();
    await vi.advanceTimersByTimeAsync(20_000);
    onUtterance(blob());
    await tick();
    expect(command).toHaveBeenCalledTimes(1);
  });

  it("pauses the microphone work while Friend speaks, and not while waiting for the answer", async () => {
    await hf.enable();
    await woken();
    mode = "speaking";
    hf.sync();
    expect(listener.pause).toHaveBeenLastCalledWith(true);
    mode = "idle";
    hf.sync();
    expect(listener.pause).toHaveBeenLastCalledWith(false);
    hf.sync(); // showing "listening" is not "busy"
    expect(listener.pause).toHaveBeenLastCalledWith(false);
  });

  it("does not report 'nothing heard' as a failure", async () => {
    command.mockResolvedValue({ text: "" });
    await hf.enable();
    await woken();
    mode = "listening";
    onUtterance(blob());
    await tick();
    expect(alerts()).toEqual([]);
    expect(hf.awake).toBe(true);
  });

  it("stays awake when the server is busy, and says nothing", async () => {
    command.mockRejectedValue(new Error("Friend is busy with the last request. Try again in a moment."));
    await hf.enable();
    await woken();
    mode = "listening";
    onUtterance(blob());
    await tick();
    expect(alerts()).toEqual([]);
    expect(hf.awake).toBe(true);
  });

  it("drops everything when turned off", async () => {
    await hf.enable();
    await woken();
    hf.disable();
    expect(hf.awake).toBe(false);
    expect(mode).toBe("idle");
    onUtterance(blob());
    await tick();
    expect(command).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(40_000); // the old clock must not fire into the next session
    expect(alerts()).toEqual([]);
  });

  it("animates with the voice while awake and waiting, like the held key does", async () => {
    await hf.enable();
    await woken();
    actions.length = 0;
    await vi.advanceTimersByTimeAsync(200);
    const levels = actions.filter((a) => (a as { type: string }).type === "voice.level");
    expect(levels.length).toBeGreaterThanOrEqual(3);
    expect(levels[0]).toEqual({ type: "voice.level", level: 0.5 });
  });

  it("stops animating while Friend works or speaks (the player draws then) and when asleep", async () => {
    await hf.enable();
    await woken();
    mode = "speaking";
    hf.sync();
    actions.length = 0;
    await vi.advanceTimersByTimeAsync(300);
    expect(actions.filter((a) => (a as { type: string }).type === "voice.level")).toHaveLength(0);
    mode = "idle";
    hf.sync();
    await vi.advanceTimersByTimeAsync(31_000); // falls asleep
    actions.length = 0;
    await vi.advanceTimersByTimeAsync(300);
    expect(actions.filter((a) => (a as { type: string }).type === "voice.level")).toHaveLength(0);
  });
});
