import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuckLevel, duckMedia, duckYoutube } from "./duck";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the level that music and video are turned to", () => {
  it("starts at normal", () => {
    expect(new DuckLevel().level).toBe(1);
  });

  it("slides to the new level instead of jumping, and ends exactly on it", () => {
    const d = new DuckLevel();
    const seen: number[] = [];
    d.subscribe((l) => seen.push(l));
    d.set(0.25);
    vi.advanceTimersByTime(400);
    expect(d.level).toBe(0.25);
    expect(seen.length).toBeGreaterThan(3);
    expect(seen.every((l) => l >= 0.25 && l <= 1)).toBe(true);
    expect(seen).toEqual([...seen].sort((a, b) => b - a)); // only ever down on the way down
    expect(seen.at(-1)).toBe(0.25);
  });

  it("slides back up the same way", () => {
    const d = new DuckLevel();
    d.set(0.25);
    vi.advanceTimersByTime(400);
    d.set(1);
    vi.advanceTimersByTime(400);
    expect(d.level).toBe(1);
  });

  it("can jump at once", () => {
    const d = new DuckLevel();
    d.set(0.5, 0);
    expect(d.level).toBe(0.5);
  });

  it("a new level in the middle of a slide goes from where it is", () => {
    const d = new DuckLevel();
    d.set(0, 300);
    vi.advanceTimersByTime(150);
    const mid = d.level;
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(1);
    d.set(1, 300);
    vi.advanceTimersByTime(20);
    expect(d.level).toBeGreaterThanOrEqual(mid);
    vi.advanceTimersByTime(400);
    expect(d.level).toBe(1);
  });

  it("keeps the level between 0 and 1", () => {
    const d = new DuckLevel();
    d.set(7, 0);
    expect(d.level).toBe(1);
    d.set(-3, 0);
    expect(d.level).toBe(0);
    d.set(Number.NaN, 0);
    expect(d.level).toBe(1);
  });

  it("stops telling a listener that unsubscribed", () => {
    const d = new DuckLevel();
    const cb = vi.fn();
    const off = d.subscribe(cb);
    off();
    d.set(0.5, 0);
    expect(cb).not.toHaveBeenCalled();
  });
});

/** The parts of a <video> that matter here. */
function fakeMedia(volume = 1) {
  const listeners = new Set<() => void>();
  return {
    volume,
    addEventListener: (_t: string, f: () => void) => void listeners.add(f),
    removeEventListener: (_t: string, f: () => void) => void listeners.delete(f),
    /** The viewer moves the volume slider. */
    userSets(v: number) {
      this.volume = v;
      for (const f of [...listeners]) f();
    },
    /** What the browser does after a script sets volume. */
    changed() {
      for (const f of [...listeners]) f();
    },
  };
}

describe("turning a video element down", () => {
  it("lowers its volume and puts it back to what it was", () => {
    const d = new DuckLevel();
    const m = fakeMedia(0.8);
    const off = duckMedia(m as never, d);
    d.set(0.5, 0);
    expect(m.volume).toBeCloseTo(0.4);
    m.changed(); // the browser reports our own change: it is not the viewer
    d.set(1, 0);
    expect(m.volume).toBeCloseTo(0.8);
    off();
  });

  it("keeps a volume the viewer sets meanwhile, and returns to that one", () => {
    const d = new DuckLevel();
    const m = fakeMedia(1);
    duckMedia(m as never, d);
    d.set(0.5, 0);
    m.changed();
    m.userSets(0.6); // while it is down, the viewer picks a new volume
    d.set(1, 0);
    expect(m.volume).toBeCloseTo(1); // 0.6 against a lowered 0.5 means they asked for more than full: it is capped at full
  });

  it("does nothing to an element it was never asked to turn down", () => {
    const d = new DuckLevel();
    const m = fakeMedia(0.7);
    duckMedia(m as never, d);
    expect(m.volume).toBe(0.7);
  });

  it("starts lowered when it appears while someone is talking", () => {
    const d = new DuckLevel();
    d.set(0.5, 0);
    const m = fakeMedia(1);
    duckMedia(m as never, d);
    expect(m.volume).toBeCloseTo(0.5);
  });

  it("lets go when it is no longer needed, and restores the volume", () => {
    const d = new DuckLevel();
    const m = fakeMedia(1);
    const off = duckMedia(m as never, d);
    d.set(0.5, 0);
    off();
    expect(m.volume).toBe(1);
    d.set(0.2, 0);
    expect(m.volume).toBe(1); // no longer follows
  });
});

/** The parts of YouTube's embedded player that matter here: it answers messages and reports its volume. */
function fakeYoutube() {
  const sent: unknown[] = [];
  const win = { postMessage: (data: string, origin: string) => sent.push({ data: JSON.parse(data), origin }) };
  const frame = { contentWindow: win } as unknown as HTMLIFrameElement;
  const listeners = new Set<(e: MessageEvent) => void>();
  const target = {
    addEventListener: (_t: string, f: (e: MessageEvent) => void) => void listeners.add(f),
    removeEventListener: (_t: string, f: (e: MessageEvent) => void) => void listeners.delete(f),
  } as unknown as Window;
  const say = (info: { volume?: number }, source: unknown = win) => {
    for (const f of [...listeners]) f({ source, origin: "https://www.youtube-nocookie.com", data: JSON.stringify({ event: "infoDelivery", info }) } as MessageEvent);
  };
  const volumes = () => sent.filter((s) => (s as { data: { func?: string } }).data.func === "setVolume").map((s) => (s as { data: { args: number[] } }).data.args[0]);
  return { frame, target, sent, say, volumes };
}

describe("turning YouTube's own player down", () => {
  it("asks the player to report, then lowers its volume and puts it back", () => {
    const d = new DuckLevel();
    const y = fakeYoutube();
    const off = duckYoutube(y.frame, d, y.target);
    expect(y.sent.some((s) => (s as { data: { event?: string } }).data.event === "listening")).toBe(true);
    y.say({ volume: 80 });
    d.set(0.5, 0);
    expect(y.volumes()).toEqual([40]);
    y.say({ volume: 40 });
    d.set(1, 0);
    expect(y.volumes()).toEqual([40, 80]);
    off();
  });

  it("talks only to YouTube's own address", () => {
    const d = new DuckLevel();
    const y = fakeYoutube();
    duckYoutube(y.frame, d, y.target);
    d.set(0.5, 0);
    expect(y.sent.every((s) => (s as { origin: string }).origin === "https://www.youtube-nocookie.com")).toBe(true);
  });

  it("leaves the player alone while nobody has talked", () => {
    const d = new DuckLevel();
    const y = fakeYoutube();
    duckYoutube(y.frame, d, y.target);
    y.say({ volume: 55 });
    expect(y.volumes()).toEqual([]); // nothing was lowered, so nothing is "restored" over the viewer's own volume
  });

  it("keeps a volume the viewer sets meanwhile", () => {
    const d = new DuckLevel();
    const y = fakeYoutube();
    duckYoutube(y.frame, d, y.target);
    y.say({ volume: 100 });
    d.set(0.5, 0);
    y.say({ volume: 50 });
    y.say({ volume: 30 }); // the viewer drags it down while it is lowered
    d.set(1, 0);
    expect(y.volumes().at(-1)).toBe(60); // 30 was half of what they chose
  });

  it("ignores messages that do not come from its own player", () => {
    const d = new DuckLevel();
    const y = fakeYoutube();
    duckYoutube(y.frame, d, y.target);
    y.say({ volume: 10 }, { postMessage() {} });
    d.set(0.5, 0);
    expect(y.volumes()).toEqual([50]); // still from the default 100, not the stranger's 10
  });

  it("starts lowered when it opens while someone is talking", () => {
    const d = new DuckLevel();
    d.set(0.5, 0);
    const y = fakeYoutube();
    duckYoutube(y.frame, d, y.target);
    expect(y.volumes()).toEqual([50]);
  });
});
