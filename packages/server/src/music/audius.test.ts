import { describe, expect, it } from "vitest";
import { AudiusHub, isAudiusAddress } from "./audius";
import { fakeAudius } from "./testing/fakeAudius";

function setup(over: { installed?: boolean; enabled?: boolean; requestTimeoutMs?: number } = {}) {
  const fake = fakeAudius();
  const config = { music: { audius: { installed: over.installed ?? true, enabled: over.enabled ?? true } } };
  const hub = new AudiusHub({ config: () => config as never, fetch: fake.fetch, ...(over.requestTimeoutMs ? { requestTimeoutMs: over.requestTimeoutMs } : {}) });
  return { fake, hub };
}

describe("status", () => {
  it("needs nothing but to be installed and switched on", () => {
    expect(setup({ installed: false, enabled: false }).hub.status()).toMatchObject({ connected: false, needs: expect.stringMatching(/install and switch on audius/i) });
    expect(setup({ enabled: false }).hub.status().connected).toBe(false);
    expect(setup().hub.status()).toEqual({ connected: true, needs: null, account: null });
  });
});

describe("searching", () => {
  it("returns streamable, ungated tracks with refs, artist and seconds, naming the app", async () => {
    const { fake, hub } = setup();
    const all = await hub.search("", 10);
    expect(all.map((t) => t.ref)).toEqual(["audius:95wro", "audius:aANABaw"]);
    expect(all[0]).toEqual({ ref: "audius:95wro", source: "audius", title: "Stars In The Sky - Lofi Beats", artist: "Lofi Army", album: "", durationSec: 71 });
    const u = new URL(fake.requests[0]!.url);
    expect(u.searchParams.get("app_name")).toBe("Friend");
    expect(u.searchParams.get("limit")).toBe("10");
  });

  it("passes the words, keeps quotes and emoji, and bounds the limit", async () => {
    const { fake, hub } = setup();
    const [t] = await hub.search("quote", 500);
    expect(t!.title).toBe('Quote "Me" 🎧');
    expect(new URL(fake.requests[0]!.url).searchParams.get("limit")).toBe("50");
    expect(new URL(fake.requests[0]!.url).searchParams.get("query")).toBe("quote");
  });

  it("says one sentence for a busy, broken or hung Audius", async () => {
    const { fake, hub } = setup({ requestTimeoutMs: 100 });
    fake.rateLimit = true;
    await expect(hub.search("x", 3)).rejects.toThrow(/slow down/i);
    fake.rateLimit = false;
    fake.garbage = true;
    await expect(hub.search("x", 3)).rejects.toThrow(/did not answer properly/i);
    fake.garbage = false;
    fake.hang = true;
    await expect(hub.search("x", 3)).rejects.toThrow(/could not reach/i);
  });
});

describe("tracks", () => {
  it("finds one track, null for a gated or unknown one, and refuses odd ids", async () => {
    const { hub } = setup();
    expect((await hub.track("95wro"))?.title).toBe("Stars In The Sky - Lofi Beats");
    expect(await hub.track("gated1")).toBeNull();
    expect(await hub.track("nope")).toBeNull();
    expect(await hub.track("../x")).toBeNull();
    expect(await hub.playlists(5)).toEqual([]);
    expect(await hub.tracksOf("1", 5)).toEqual([]);
  });
});

describe("isAudiusAddress", () => {
  it("accepts an https content-node address with the stream path, and nothing odd", () => {
    expect(isAudiusAddress("https://creatornode.audius.co/tracks/cidstream/Qm1?signature=x")).toBe(true);
    expect(isAudiusAddress("https://audius-content.some-host.com/tracks/cidstream/Qm1")).toBe(true);
    for (const bad of [
      "http://creatornode.audius.co/tracks/cidstream/Qm1",
      "https://127.0.0.1/tracks/cidstream/Qm1",
      "https://10.0.0.5/tracks/cidstream/Qm1",
      "https://[::1]/tracks/cidstream/Qm1",
      "https://localhost/tracks/cidstream/Qm1",
      "https://printer.local/tracks/cidstream/Qm1",
      "https://nas.internal/tracks/cidstream/Qm1",
      "https://intranet/tracks/cidstream/Qm1",
      "https://user:pw@creatornode.audius.co/tracks/cidstream/Qm1",
      "https://creatornode.audius.co:8443/tracks/cidstream/Qm1",
      "https://creatornode.audius.co/other/path",
      "file:///etc/passwd",
      "nonsense",
    ]) {
      expect(isAudiusAddress(bad), bad).toBe(false);
    }
  });
});

describe("streamOf", () => {
  it("gives the content node's address from Audius's redirect", async () => {
    const { hub } = setup();
    expect(await hub.streamOf("95wro")).toEqual({ ok: true, url: expect.stringContaining("https://creatornode.audius.co/tracks/cidstream/QmAbc") });
  });

  it("says a gated or unknown track cannot be played, and refuses odd ids", async () => {
    const { hub } = setup();
    expect(await hub.streamOf("gated1")).toEqual({ ok: false, error: expect.stringMatching(/cannot be played/i) });
    expect((await hub.streamOf("../x")).ok).toBe(false);
  });

  it("refuses a redirect to a private or odd place, with no address in the sentence", async () => {
    const { fake, hub } = setup();
    fake.node = "https://127.0.0.1/tracks/cidstream/Qm1?signature=TOPSECRET";
    const r = await hub.streamOf("95wro");
    expect(r.ok).toBe(false);
    expect(JSON.stringify(r)).not.toMatch(/127\.0|TOPSECRET/);
    fake.node = "https://evil.example.com/other?signature=TOPSECRET";
    expect((await hub.streamOf("95wro")).ok).toBe(false);
  });
});

describe("fetchAudio", () => {
  it("passes a range request through and returns the partial answer", async () => {
    const { fake, hub } = setup();
    const r = await hub.fetchAudio("https://creatornode.audius.co/tracks/cidstream/Qm1", "bytes=0-9");
    expect(r.ok && r.res.status).toBe(206);
    expect(fake.requests.at(-1)!.headers.range).toBe("bytes=0-9");
  });

  it("follows a redirect to another vetted node, refuses a foreign one, and stops after three hops", async () => {
    const { fake, hub } = setup();
    fake.nodeRedirect = "https://other-node.example.org/tracks/cidstream/Qm2?hop=1";
    const ok = await hub.fetchAudio("https://creatornode.audius.co/tracks/cidstream/Qm1");
    expect(ok.ok).toBe(true);
    fake.nodeRedirect = "https://127.0.0.1/tracks/cidstream/Qm2";
    const bad = await hub.fetchAudio("https://creatornode.audius.co/tracks/cidstream/Qm1");
    expect(bad).toEqual({ ok: false, error: expect.stringMatching(/will not follow/i) });
    expect(fake.requests.some((q) => q.url.includes("127.0.0.1"))).toBe(false);
    fake.nodeRedirect = "https://loop.example.org/tracks/cidstream/Qm3";
    const loop = await hub.fetchAudio("https://creatornode.audius.co/tracks/cidstream/Qm1");
    expect(loop).toEqual({ ok: false, error: expect.stringMatching(/too many times/i) });
  });

  it("refuses an address that is not a content-node address at the start", async () => {
    const { fake, hub } = setup();
    const before = fake.requests.length;
    expect((await hub.fetchAudio("https://evil.example.com/steal.mp3")).ok).toBe(false);
    expect(fake.requests.length).toBe(before);
  });
});
