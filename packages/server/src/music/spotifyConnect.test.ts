import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MusicTokens } from "./oauth";
import { SpotifyHub } from "./spotify";
import { fakeSpotify } from "./testing/fakeSpotify";

const CLIENT = "abc123DEF456ghi789";
async function setup() {
  const fake = fakeSpotify();
  const tokens = new MusicTokens(mkdtempSync(join(tmpdir(), "friend-connect-")));
  const config = { music: { spotify: { installed: true, enabled: true, clientId: CLIENT } } };
  const hub = new SpotifyHub({ config: () => config as never, tokens, fetch: fake.fetch, clock: () => 1_000_000, publicBase: () => "https://friend.example.com" });
  const state = new URL(hub.connectUrl()!).searchParams.get("state")!;
  await hub.completeLogin({ code: fake.issueCode(), state });
  return { fake, hub };
}

describe("Spotify devices", () => {
  it("lists the account's devices", async () => {
    const { hub } = await setup();
    expect(await hub.devices()).toEqual([
      { id: "D1", name: "Living room", active: false },
      { id: "D2", name: "Kitchen", active: true },
    ]);
  });

  it("plays tracks on the device with that name, whatever its case, as spotify:track uris", async () => {
    const { hub, fake } = await setup();
    expect(await hub.playOn("  living ROOM ", ["4uLU6hMCjMI75M1A2tKUQC", "7qiZfU4dY1lWllzX7mPBI3"])).toEqual({ ok: true, deviceId: "D1" });
    expect(fake.player.at(-1)).toEqual({ call: "PUT /v1/me/player/play?device_id=D1", body: { uris: ["spotify:track:4uLU6hMCjMI75M1A2tKUQC", "spotify:track:7qiZfU4dY1lWllzX7mPBI3"] } });
  });

  it("starts part-way in when asked", async () => {
    const { hub, fake } = await setup();
    await hub.playOn("Kitchen", ["4uLU6hMCjMI75M1A2tKUQC"], 30_000);
    expect(fake.player.at(-1)!.body).toMatchObject({ position_ms: 30_000 });
  });

  it("says which devices it found when the name is not there, and plays nothing", async () => {
    const { hub, fake } = await setup();
    const r = await hub.playOn("Garage", ["4uLU6hMCjMI75M1A2tKUQC"]);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/"Garage".*Living room.*Kitchen/) });
    expect(fake.player).toHaveLength(0);
    fake.devices = [];
    expect(await hub.playOn("Garage", ["4uLU6hMCjMI75M1A2tKUQC"])).toEqual({ ok: false, error: expect.stringMatching(/Open Spotify/i) });
  });

  it("refuses an id that is not a Spotify track, without calling Spotify", async () => {
    const { hub, fake } = await setup();
    expect((await hub.playOn("Kitchen", ["../x"])).ok).toBe(false);
    expect(fake.player).toHaveLength(0);
  });

  it("a free account is told Premium is needed", async () => {
    const { hub, fake } = await setup();
    fake.premium = false;
    expect(await hub.playOn("Kitchen", ["4uLU6hMCjMI75M1A2tKUQC"])).toEqual({ ok: false, error: expect.stringMatching(/Premium/) });
  });

  it("controls the device: pause, resume, next, previous, seek, volume, each on that device", async () => {
    const { hub, fake } = await setup();
    await hub.control("D1", { action: "pause" });
    await hub.control("D1", { action: "resume" });
    await hub.control("D1", { action: "next" });
    await hub.control("D1", { action: "previous" });
    await hub.control("D1", { action: "seek", ms: 12_345.6 });
    await hub.control("D1", { action: "volume", percent: 250 });
    expect(fake.player.map((p) => p.call)).toEqual([
      "PUT /v1/me/player/pause?device_id=D1",
      "PUT /v1/me/player/play?device_id=D1",
      "POST /v1/me/player/next?device_id=D1",
      "POST /v1/me/player/previous?device_id=D1",
      "PUT /v1/me/player/seek?position_ms=12346&device_id=D1",
      "PUT /v1/me/player/volume?volume_percent=100&device_id=D1",
    ]);
  });

  it("reads what is playing, or null when nothing is", async () => {
    const { hub, fake } = await setup();
    expect(await hub.playbackState()).toBeNull();
    fake.playback = { is_playing: true, progress_ms: 5000, item: { id: "4uLU6hMCjMI75M1A2tKUQC", duration_ms: 213000 }, device: { name: "Kitchen" } };
    expect(await hub.playbackState()).toEqual({ playing: true, trackId: "4uLU6hMCjMI75M1A2tKUQC", positionMs: 5000, durationMs: 213000, deviceName: "Kitchen" });
  });

  it("a rate limit or a page that is not JSON is one sentence and one call, and no message shows a token", async () => {
    const { hub, fake } = await setup();
    fake.rateLimit = true;
    const n = fake.requests.length;
    const r = await hub.playOn("Kitchen", ["4uLU6hMCjMI75M1A2tKUQC"]);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/slow down/i) });
    expect(fake.requests.length - n).toBeLessThanOrEqual(1);
    expect(JSON.stringify(r)).not.toMatch(/AT-\d|RT-\d/);
    fake.rateLimit = false;
    fake.garbage = true;
    await expect(hub.playbackState()).rejects.toThrow(/did not answer/i);
  });
});
