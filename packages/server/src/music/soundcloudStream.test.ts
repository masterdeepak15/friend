import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MusicSecrets, MusicTokens } from "./oauth";
import { isSoundCloudAddress, SoundCloudHub } from "./soundcloud";
import { fakeSoundCloud } from "./testing/fakeSoundCloud";

async function setup() {
  const fake = fakeSoundCloud();
  const dir = mkdtempSync(join(tmpdir(), "friend-scs-"));
  const secrets = new MusicSecrets(dir);
  secrets.set("soundcloud", "sec");
  const config = { music: { soundcloud: { installed: true, enabled: true, clientId: "abc123DEF456ghi789jkl012MNO345pq" } } };
  const hub = new SoundCloudHub({ config: () => config as never, tokens: new MusicTokens(dir), secrets, fetch: fake.fetch, publicBase: () => "https://f.example.com" });
  await hub.completeLogin({ code: fake.issueCode(), state: new URL(hub.connectUrl()!).searchParams.get("state")! });
  return { fake, hub };
}

describe("isSoundCloudAddress", () => {
  it("accepts https on SoundCloud's own hosts and nothing else", () => {
    expect(isSoundCloudAddress("https://cf-media.sndcdn.com/a.mp3?sig=1")).toBe(true);
    expect(isSoundCloudAddress("https://api.soundcloud.com/x")).toBe(true);
    for (const bad of ["http://cf-media.sndcdn.com/a", "https://evil.example.com/a", "https://sndcdn.com.evil.com/a", "https://notsoundcloud.com/a", "file:///etc/passwd", "javascript:1", "nonsense", "https://evilsndcdn.com/a"]) {
      expect(isSoundCloudAddress(bad)).toBe(false);
    }
  });
});

describe("streamOf", () => {
  it("gives the vetted address for a playable track", async () => {
    const { hub } = await setup();
    expect(await hub.streamOf("1001")).toEqual({ ok: true, url: "https://cf-media.sndcdn.com/track.mp3?sig=SECRETSIG" });
  });

  it("refuses an address that is not SoundCloud's, in a sentence without the address", async () => {
    const { fake, hub } = await setup();
    fake.streamUrl = "https://evil.example.com/steal.mp3?sig=TOPSECRET";
    const r = await hub.streamOf("1001");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/no playable address/i) });
    expect(JSON.stringify(r)).not.toMatch(/evil|TOPSECRET/);
    fake.streamUrl = "http://cf-media.sndcdn.com/a.mp3";
    expect((await hub.streamOf("1001")).ok).toBe(false);
  });

  it("says a blocked track, a preview-only track or an odd id cannot be played", async () => {
    const { hub } = await setup();
    expect(await hub.streamOf("1003")).toEqual({ ok: false, error: expect.stringMatching(/does not let this account play/i) });
    expect((await hub.streamOf("1004")).ok).toBe(false);
    expect((await hub.streamOf("../me")).ok).toBe(false);
  });
});

describe("a track SoundCloud forbids", () => {
  it("is not playable for this account, and does not tell the owner to reconnect", async () => {
    const { fake, hub } = await setup();
    fake.forbidden.add(1001);
    const r = await hub.streamOf("1001");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/does not let this account play/i) });
    expect(JSON.stringify(r)).not.toMatch(/reconnect/i);
  });
});

describe("fetchAudio", () => {
  it("passes a range request through and returns the partial answer", async () => {
    const { fake, hub } = await setup();
    const r = await hub.fetchAudio("https://cf-media.sndcdn.com/track.mp3?sig=1", "bytes=0-9");
    expect(r.ok && r.res.status).toBe(206);
    expect(fake.requests.at(-1)!.headers.range).toBe("bytes=0-9");
  });

  it("follows a redirect that stays on SoundCloud, up to three hops", async () => {
    const { fake, hub } = await setup();
    fake.redirectTo = "https://cf-media.sndcdn.com/other.mp3";
    // the fake redirects every request to this host, so it loops: three hops then a sentence
    const r = await hub.fetchAudio("https://cf-media.sndcdn.com/track.mp3");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/too many times/i) });
  });

  it("refuses a redirect to a foreign host, and never asks that host", async () => {
    const { fake, hub } = await setup();
    fake.redirectTo = "https://evil.example.com/steal.mp3";
    const r = await hub.fetchAudio("https://cf-media.sndcdn.com/track.mp3");
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/will not follow/i) });
    expect(fake.requests.some((q) => q.url.includes("evil.example.com"))).toBe(false);
  });

  it("refuses an address that is not SoundCloud's at the start", async () => {
    const { fake, hub } = await setup();
    const before = fake.requests.length;
    expect((await hub.fetchAudio("https://evil.example.com/a.mp3")).ok).toBe(false);
    expect(fake.requests.length).toBe(before);
  });
});
