import { describe, expect, it, vi } from "vitest";
import { createSpotifyEngine, type SpotifySdk } from "./spotifyEngine";

type Listener = (arg: never) => void;
let autoReady = true;
class FakePlayer {
  listeners: Record<string, Listener[]> = {};
  calls: string[] = [];
  volumeSet: number[] = [];
  constructor(public opts: { name: string; getOAuthToken: (cb: (t: string) => void) => void; volume?: number }) {}
  addListener(ev: string, fn: Listener) {
    (this.listeners[ev] ??= []).push(fn);
    return true;
  }
  fire(ev: string, arg?: unknown) {
    for (const f of this.listeners[ev] ?? []) (f as (a: unknown) => void)(arg);
  }
  async connect() {
    this.calls.push("connect");
    if (autoReady) queueMicrotask(() => this.fire("ready", { device_id: "DEV1" }));
    return true;
  }
  disconnect() {}
  pause = async () => void this.calls.push("pause");
  resume = async () => void this.calls.push("resume");
  seek = async (ms: number) => void this.calls.push(`seek:${ms}`);
  setVolume = async (v: number) => void this.volumeSet.push(v);
}

function setup(over: { putStatus?: number; putBody?: unknown; autoReady?: boolean; holdPut?: boolean; readyTimeoutMs?: number } = {}) {
  const made: FakePlayer[] = [];
  const held: (() => void)[] = [];
  autoReady = over.autoReady !== false;
  let player!: FakePlayer;
  const sdk: SpotifySdk = { Player: class extends FakePlayer { constructor(o: ConstructorParameters<typeof FakePlayer>[0]) { super(o); player = this; made.push(this); } } as never };
  const loadSdk = vi.fn(async () => sdk);
  const puts: { url: string; body: unknown; auth: string }[] = [];
  const fetchFn = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    puts.push({ url: String(url), body: init?.body ? JSON.parse(String(init.body)) : null, auth: String((init?.headers as Record<string, string>)?.authorization ?? "") });
    if (over.holdPut) await new Promise<void>((r) => held.push(r));
    return new Response(over.putBody ? JSON.stringify(over.putBody) : null, { status: over.putStatus ?? 204 });
  }) as unknown as typeof fetch;
  const getToken = vi.fn(async () => "TOKEN-1");
  const e = createSpotifyEngine({ loadSdk, getToken, fetch: fetchFn, deviceName: "Friend", now: () => 1_000, ...(over.readyTimeoutMs ? { readyTimeoutMs: over.readyTimeoutMs } : {}) });
  return { e, loadSdk, getToken, puts, player: () => player, made, release: () => held.splice(0).forEach((r) => r()) };
}

const stateOf = (over: Record<string, unknown> = {}) => ({ paused: false, position: 12_000, duration: 200_000, track_window: { current_track: { id: "4uLU6hMCjMI75M1A2tKUQC" }, previous_tracks: [] }, ...over });

describe("the Spotify engine", () => {
  it("does not load Spotify's script until a Spotify track is played", async () => {
    const { loadSdk, e } = setup();
    e.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    e.volume = 0.5;
    expect(loadSdk).not.toHaveBeenCalled();
  });

  it("makes this tab a device named Friend, starts the track on it with the owner's token", async () => {
    const { e, loadSdk, puts, player } = setup();
    e.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    await e.play();
    expect(loadSdk).toHaveBeenCalledTimes(1);
    expect(player().opts.name).toBe("Friend");
    expect(player().calls).toContain("connect");
    expect(puts).toHaveLength(1);
    expect(puts[0]!.url).toBe("https://api.spotify.com/v1/me/player/play?device_id=DEV1");
    expect(puts[0]!.body).toEqual({ uris: ["spotify:track:4uLU6hMCjMI75M1A2tKUQC"] });
    expect(puts[0]!.auth).toBe("Bearer TOKEN-1");
    expect(e.paused).toBe(false);
  });

  it("gives Spotify its token whenever the player asks", async () => {
    const { e, player, getToken } = setup();
    e.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    await e.play();
    const cb = vi.fn();
    player().opts.getOAuthToken(cb);
    await vi.waitFor(() => expect(cb).toHaveBeenCalledWith("TOKEN-1"));
    expect(getToken).toHaveBeenCalled();
  });

  it("pauses, then resumes the same track without starting it again", async () => {
    const { e, puts, player } = setup();
    e.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    await e.play();
    e.pause();
    expect(player().calls).toContain("pause");
    expect(e.paused).toBe(true);
    await e.play();
    expect(player().calls).toContain("resume");
    expect(puts).toHaveLength(1);
  });

  it("a new source starts that track", async () => {
    const { e, puts } = setup();
    e.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    await e.play();
    e.src = "spotify:7qiZfU4dY1lWllzX7mPBI3";
    await e.play();
    expect(puts).toHaveLength(2);
    expect(puts[1]!.body).toEqual({ uris: ["spotify:track:7qiZfU4dY1lWllzX7mPBI3"] });
  });

  it("follows Spotify's own state: position, length, and the events the player listens to", async () => {
    const { e, player } = setup();
    const seen: string[] = [];
    for (const t of ["timeupdate", "loadedmetadata", "durationchange", "ended", "error"]) e.addEventListener(t, () => seen.push(t));
    e.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    await e.play();
    player().fire("player_state_changed", stateOf());
    expect(e.currentTime).toBe(12);
    expect(e.duration).toBe(200);
    expect(seen).toEqual(expect.arrayContaining(["timeupdate", "loadedmetadata", "durationchange"]));
    expect(seen).not.toContain("ended");
  });

  it("says the track ended when Spotify stops at the start and lists it as played", async () => {
    const { e, player } = setup();
    const ended = vi.fn();
    e.addEventListener("ended", ended);
    e.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    await e.play();
    player().fire("player_state_changed", stateOf({ paused: true, position: 0, track_window: { current_track: { id: "4uLU6hMCjMI75M1A2tKUQC" }, previous_tracks: [{ id: "4uLU6hMCjMI75M1A2tKUQC" }] } }));
    expect(ended).toHaveBeenCalledTimes(1);
    player().fire("player_state_changed", stateOf({ paused: true, position: 0, track_window: { current_track: { id: "4uLU6hMCjMI75M1A2tKUQC" }, previous_tracks: [{ id: "4uLU6hMCjMI75M1A2tKUQC" }] } }));
    expect(ended).toHaveBeenCalledTimes(1);
  });

  it("seeks and sets the volume (mute is volume zero) on Spotify's player", async () => {
    const { e, player } = setup();
    e.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    e.volume = 0.4;
    await e.play();
    expect(player().opts.volume).toBeCloseTo(0.4);
    e.currentTime = 90.5;
    expect(player().calls).toContain("seek:90500");
    e.volume = 0.7;
    e.muted = true;
    e.muted = false;
    expect(player().volumeSet).toEqual([0.7, 0, 0.7]);
  });

  it("a free account is told plainly that Premium is needed, and the track is reported as failed", async () => {
    const { e, player } = setup({ autoReady: false });
    const failed = vi.fn();
    e.addEventListener("error", failed);
    e.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    const p = e.play();
    await vi.waitFor(() => expect(player()).toBeDefined());
    player().fire("account_error", { message: "Premium required" });
    await expect(p).rejects.toThrow(/Premium/);
    expect(failed).toHaveBeenCalled();
    expect(e.error).toMatch(/Premium/);
  });

  it("an answer of 403 or 404 when starting the track is turned into one plain sentence", async () => {
    const forbidden = setup({ putStatus: 403, putBody: { error: { reason: "PREMIUM_REQUIRED" } } });
    forbidden.e.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    await expect(forbidden.e.play()).rejects.toThrow(/Premium/);
    expect(forbidden.e.error).toMatch(/Premium/);
    const gone = setup({ putStatus: 404 });
    gone.e.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    await expect(gone.e.play()).rejects.toThrow(/Spotify/);
  });

  it("when Spotify's script cannot be loaded, play fails with a sentence, not a crash", async () => {
    const e = createSpotifyEngine({ loadSdk: async () => { throw new Error("blocked"); }, getToken: async () => "T", fetch: (async () => new Response(null, { status: 204 })) as never });
    e.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    await expect(e.play()).rejects.toThrow(/Spotify/);
  });

  it("keeps one player after a failure, and uses the device id Spotify announces last", async () => {
    const bad = setup({ putStatus: 429 });
    bad.e.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    await expect(bad.e.play()).rejects.toThrow();
    bad.e.src = "spotify:7qiZfU4dY1lWllzX7mPBI3";
    await expect(bad.e.play()).rejects.toThrow();
    expect(bad.made).toHaveLength(1);
    expect(bad.loadSdk).toHaveBeenCalledTimes(1);

    const t = setup();
    t.e.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    await t.e.play();
    t.player().fire("ready", { device_id: "DEV2" });
    t.e.src = "spotify:7qiZfU4dY1lWllzX7mPBI3";
    await t.e.play();
    expect(t.puts.at(-1)!.url).toContain("device_id=DEV2");
    expect(t.made).toHaveLength(1);
  });

  it("a failure after the player was ready does not touch the next play's promise", async () => {
    const t = setup();
    t.e.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    await t.e.play();
    t.player().fire("playback_error", {});
    t.e.src = "spotify:7qiZfU4dY1lWllzX7mPBI3";
    await expect(t.e.play()).resolves.toBeUndefined();
  });

  it("a track chosen while the last one is still starting is started in its own right", async () => {
    const t = setup({ holdPut: true });
    t.e.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    const first = t.e.play();
    await vi.waitFor(() => expect(t.puts).toHaveLength(1));
    t.e.src = "spotify:7qiZfU4dY1lWllzX7mPBI3";
    t.release();
    await first;
    const second = t.e.play();
    await vi.waitFor(() => expect(t.puts).toHaveLength(2));
    t.release();
    await second;
    expect(t.puts[1]!.body).toEqual({ uris: ["spotify:track:7qiZfU4dY1lWllzX7mPBI3"] });
  });

  it("gives up with a sentence when Spotify's player never says it is ready", async () => {
    const t = setup({ autoReady: false, readyTimeoutMs: 20 });
    const failed = vi.fn();
    t.e.addEventListener("error", failed);
    t.e.src = "spotify:4uLU6hMCjMI75M1A2tKUQC";
    await expect(t.e.play()).rejects.toThrow(/did not start/i);
    expect(t.e.error).toMatch(/did not start/i);
    expect(failed).toHaveBeenCalled();
  });

  it("refuses an address that is not a Spotify track ref", async () => {
    const { e } = setup();
    e.src = "spotify:../../x";
    await expect(e.play()).rejects.toThrow();
  });
});
