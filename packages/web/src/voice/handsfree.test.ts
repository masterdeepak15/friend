import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { HandsFree } from "./handsfree";

const blob = (n = 1000) => new Blob([new Uint8Array(n)]);
const tick = () => vi.advanceTimersByTimeAsync(0);

let onUtterance: (b: Blob) => void;
let onError: (m: string) => void;
let listener: { start: Mock<() => Promise<void>>; stop: Mock<() => void>; pause: Mock<(on: boolean) => void>; listening: boolean };
let wake: Mock<(audio: Blob, signal?: AbortSignal) => Promise<{ text: string; wake: boolean }>>;
let command: Mock<(audio: Blob, signal?: AbortSignal) => Promise<{ text: string }>>;
let chime: Mock<() => void>;
let actions: unknown[];
let busyNow: boolean;
let hf: HandsFree;

beforeEach(() => {
  vi.useFakeTimers();
  actions = [];
  busyNow = false;
  listener = { start: vi.fn(async () => void (listener.listening = true)), stop: vi.fn(() => void (listener.listening = false)), pause: vi.fn(), listening: false };
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
    busy: () => busyNow,
    chime,
    dispatch: (a) => actions.push(a),
    followUpMs: 8000,
  });
});
afterEach(() => vi.useRealTimers());

const alerts = () => actions.filter((a) => (a as { type: string }).type === "alert.add");
const modes = () => actions.filter((a) => (a as { type: string }).type === "voice.mode").map((a) => (a as { mode: string }).mode);

describe("saying the assistant's name instead of holding a key", () => {
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

  it("asks the server about each thing said, and does nothing more when the name was not said", async () => {
    await hf.enable();
    onUtterance(blob());
    await tick();
    expect(wake).toHaveBeenCalledTimes(1);
    expect(command).not.toHaveBeenCalled();
    expect(chime).not.toHaveBeenCalled();
    expect(alerts()).toEqual([]);
  });

  it("shows that it is working while it checks what was said", async () => {
    let release!: (v: { text: string; wake: boolean }) => void;
    wake.mockImplementationOnce(() => new Promise((r) => (release = r)));
    await hf.enable();
    onUtterance(blob());
    await tick();
    expect(modes().at(-1)).toBe("transcribing");
    release({ text: "", wake: false });
    await tick();
    expect(modes().at(-1)).toBe("idle");
  });

  it("lets the server run a request that came with the name, with no sound or waiting", async () => {
    wake.mockResolvedValueOnce({ text: "open it", wake: true });
    await hf.enable();
    onUtterance(blob());
    await tick();
    expect(chime).not.toHaveBeenCalled();
    expect(command).not.toHaveBeenCalled();
  });

  it("chimes when only the name was said, then sends the next thing said as the request", async () => {
    wake.mockResolvedValueOnce({ text: "", wake: true });
    await hf.enable();
    onUtterance(blob());
    await tick();
    expect(chime).toHaveBeenCalledTimes(1);
    expect(modes()).toContain("listening");
    onUtterance(blob(2000));
    await tick();
    expect(command).toHaveBeenCalledTimes(1);
    expect(wake).toHaveBeenCalledTimes(1); // the request did not need the name again
    expect(modes().at(-1)).toBe("idle");
  });

  it("gives up waiting for the request after a few seconds, and needs the name again", async () => {
    wake.mockResolvedValueOnce({ text: "", wake: true });
    await hf.enable();
    onUtterance(blob());
    await tick();
    await vi.advanceTimersByTimeAsync(8100);
    expect(modes().at(-1)).toBe("idle");
    onUtterance(blob());
    await tick();
    expect(wake).toHaveBeenCalledTimes(2);
    expect(command).not.toHaveBeenCalled();
  });

  it("ignores what is said while Friend is busy", async () => {
    await hf.enable();
    busyNow = true;
    onUtterance(blob());
    await tick();
    expect(wake).not.toHaveBeenCalled();
  });

  it("pauses the listener while busy, but not while it is waiting for the request", async () => {
    wake.mockResolvedValueOnce({ text: "", wake: true });
    await hf.enable();
    busyNow = true;
    hf.sync();
    expect(listener.pause).toHaveBeenLastCalledWith(true);
    busyNow = false;
    hf.sync();
    expect(listener.pause).toHaveBeenLastCalledWith(false);
    onUtterance(blob());
    await tick();
    busyNow = true; // the page shows "listening" while it waits
    hf.sync();
    expect(listener.pause).toHaveBeenLastCalledWith(false);
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

  it("turns itself off, and says why, when the microphone stops", async () => {
    await hf.enable();
    onError("The microphone stopped working.");
    expect(hf.enabled).toBe(false);
    expect(alerts()).toEqual([{ type: "alert.add", level: "error", text: "The microphone stopped working." }]);
  });

  it("drops a pending request when turned off", async () => {
    wake.mockResolvedValueOnce({ text: "", wake: true });
    await hf.enable();
    onUtterance(blob());
    await tick();
    hf.disable();
    expect(modes().at(-1)).toBe("idle");
    onUtterance(blob());
    await tick();
    expect(command).not.toHaveBeenCalled();
  });
});
