import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { LocalAction } from "../store";
import { VoiceController } from "./controller";
import { AudioPlayer } from "./player";
import { useAudioUnlock } from "./unlock";

describe("useAudioUnlock", () => {
  it.each(["pointerdown", "keydown", "touchend"])("unlocks sound on the first %s anywhere on the page, and on later ones too", (type) => {
    const unlock = vi.fn();
    renderHook(() => useAudioUnlock({ unlock }));
    window.dispatchEvent(new Event(type));
    window.dispatchEvent(new Event(type));
    expect(unlock).toHaveBeenCalledTimes(2); // harmless to repeat: the player ignores it once audio runs
  });

  it("stops listening when the page part is removed", () => {
    const unlock = vi.fn();
    const { unmount } = renderHook(() => useAudioUnlock({ unlock }));
    unmount();
    window.dispatchEvent(new Event("pointerdown"));
    expect(unlock).not.toHaveBeenCalled();
  });

  it("always calls the latest unlock, not the one from the first render", () => {
    const a = vi.fn();
    const b = vi.fn();
    const { rerender } = renderHook(({ fn }) => useAudioUnlock({ unlock: fn }), { initialProps: { fn: a } });
    rerender({ fn: b });
    window.dispatchEvent(new Event("keydown"));
    expect(a).not.toHaveBeenCalled();
    expect(b).toHaveBeenCalledTimes(1);
  });
});

class FakePlayer {
  isLocked = true;
  unlocked = 0;
  chunks: unknown[] = [];
  playing() {
    return false;
  }
  stop() {}
  unlock() {
    this.unlocked++;
    this.isLocked = false;
  }
  locked() {
    return this.isLocked;
  }
  enqueue(c: unknown) {
    this.chunks.push(c);
  }
  onChange() {
    return () => {};
  }
  level() {
    return 0;
  }
}
const chunk = { type: "audio.chunk" as const, id: "1-0", seq: 0, last: true, mime: "audio/wav", data: "AAAA" };

describe("VoiceController when the browser is still blocking sound", () => {
  let player: FakePlayer;
  let actions: LocalAction[];
  let ctl: VoiceController;
  beforeEach(() => {
    player = new FakePlayer();
    actions = [];
    ctl = new VoiceController({ send: () => {}, dispatch: (a) => actions.push(a), recorder: { active: false, cancel() {}, level: () => 0 } as never, player: player as never, post: async () => ({ text: "" }), available: () => true, supported: () => true });
  });
  afterEach(() => ctl.dispose());
  const alerts = () => actions.filter((a) => a.type === "alert.add") as { text: string; level: string }[];

  it("still plays the clip, and tells the owner once how to turn the sound on", () => {
    ctl.handleServer(chunk);
    ctl.handleServer({ ...chunk, id: "1-1" });
    expect(player.chunks).toHaveLength(2);
    expect(alerts()).toHaveLength(1);
    expect(alerts()[0]!.text).toMatch(/click|press a key/i);
  });

  it("says nothing when the sound is already on", () => {
    player.isLocked = false;
    ctl.handleServer(chunk);
    expect(alerts()).toEqual([]);
  });

  it("unlock() passes the gesture on to the player", () => {
    ctl.unlock();
    expect(player.unlocked).toBe(1);
  });
});

describe("AudioPlayer.locked", () => {
  class Ctx {
    static state = "suspended";
    get state() {
      return Ctx.state;
    }
    resume() {
      Ctx.state = "running";
      return Promise.resolve();
    }
    close() {
      return Promise.resolve();
    }
    createAnalyser() {
      return { fftSize: 0, connect() {} };
    }
    get destination() {
      return {};
    }
  }
  beforeEach(() => {
    Ctx.state = "suspended";
    vi.stubGlobal("AudioContext", Ctx);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is locked until a gesture has resumed the audio, then not", async () => {
    const p = new AudioPlayer();
    expect(p.locked()).toBe(true); // nothing created yet
    p.unlock();
    await Promise.resolve();
    expect(p.locked()).toBe(false);
    p.dispose();
  });
});
