import { describe, expect, it } from "vitest";
import { AudiusHub, isAudiusAddress } from "./audius";
import { fakeAudius } from "./testing/fakeAudius";

const PRIVATE_NAMES: Record<string, string[]> = { "127.0.0.1.nip.io": ["127.0.0.1"], "mixed.example.org": ["93.184.216.34", "10.0.0.8"], "v6.example.org": ["::1"], "mapped.example.org": ["::ffff:192.168.1.5"], "nat.example.org": ["100.64.0.9"], "linklocal.example.org": ["169.254.1.1"], "ula.example.org": ["fd12:3456::1"], "gone.example.org": [] };
const resolve = async (host: string): Promise<string[]> => PRIVATE_NAMES[host] ?? ["93.184.216.34"];

function setup(over: { installed?: boolean; enabled?: boolean; requestTimeoutMs?: number } = {}) {
  const fake = fakeAudius();
  const config = { music: { audius: { installed: over.installed ?? true, enabled: over.enabled ?? true } } };
  const hub = new AudiusHub({ config: () => config as never, fetch: fake.fetch, resolve, ...(over.requestTimeoutMs ? { requestTimeoutMs: over.requestTimeoutMs } : {}) });
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

describe("isAudiusAddress, the names that mean this machine or this network", () => {
  it("is not fooled by a trailing dot, odd spellings, single-label names or reserved names", () => {
    for (const bad of [
      "https://localhost./tracks/cidstream/Qm1",
      "https://local%68ost./tracks/cidstream/Qm1",
      "https://nas.local./tracks/cidstream/Qm1",
      "https://nas.internal./tracks/cidstream/Qm1",
      "https://router./tracks/cidstream/Qm1",
      "https://x.localdomain/tracks/cidstream/Qm1",
      "https://x.test/tracks/cidstream/Qm1",
      "https://x.example/tracks/cidstream/Qm1",
      "https://x.invalid/tracks/cidstream/Qm1",
      "https://1.0.0.127.in-addr.arpa/tracks/cidstream/Qm1",
      "https://2130706433/tracks/cidstream/Qm1",
      "https://0x7f.1/tracks/cidstream/Qm1",
      "https://127.1/tracks/cidstream/Qm1",
      "https://[::ffff:127.0.0.1]/tracks/cidstream/Qm1",
    ]) {
      expect(isAudiusAddress(bad), bad).toBe(false);
    }
    expect(isAudiusAddress("https://creatornode.audius.co./tracks/cidstream/Qm1")).toBe(true);
  });
});

describe("a public name that points at a private address", () => {
  it("is refused for the first address, for a redirect, and for the stream, without naming it", async () => {
    const { fake, hub } = setup();
    for (const host of ["127.0.0.1.nip.io", "mixed.example.org", "v6.example.org", "mapped.example.org", "nat.example.org", "linklocal.example.org", "ula.example.org", "gone.example.org"]) {
      const before = fake.requests.length;
      const r = await hub.fetchAudio(`https://${host}/tracks/cidstream/Qm1?signature=TOPSECRET`);
      expect(r.ok, host).toBe(false);
      expect(JSON.stringify(r)).not.toMatch(/TOPSECRET|nip\.io/);
      expect(fake.requests.length, host).toBe(before);
    }
    fake.node = "https://127.0.0.1.nip.io/tracks/cidstream/Qm1?signature=TOPSECRET";
    expect((await hub.streamOf("95wro")).ok).toBe(false);
    fake.node = "https://creatornode.audius.co/tracks/cidstream/Qm1";
    fake.nodeRedirect = "https://127.0.0.1.nip.io/tracks/cidstream/Qm2";
    expect(await hub.fetchAudio("https://creatornode.audius.co/tracks/cidstream/Qm1")).toEqual({ ok: false, error: expect.stringMatching(/will not follow/i) });
  });
});

describe("a slow Audius", () => {
  it("gives up when the body never finishes, not only when the headers never come", async () => {
    const { fake, hub } = setup({ requestTimeoutMs: 100 });
    fake.stallBody = true;
    await expect(hub.search("x", 3)).rejects.toThrow(/could not reach/i);
    await expect(hub.track("95wro")).rejects.toThrow(/could not reach/i);
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

  it("follows the content node's redirect to the storage the audio really is in, whatever its path (the real Audius does this now)", async () => {
    const { fake, hub } = setup();
    fake.nodeRedirect = "https://validator.eeba4a6ca56a0d87af802270217c2a51.r2.cloudflarestorage.com/28p/QmAbc?X-Amz-Algorithm=AWS4-HMAC-SHA256&hop=1";
    const r = await hub.fetchAudio("https://creatornode.audius.co/tracks/cidstream/Qm1", "bytes=0-9");
    expect(r.ok && r.res.status).toBe(206);
    expect(fake.requests.at(-1)!.url).toContain("r2.cloudflarestorage.com/28p/QmAbc");
    expect(fake.requests.at(-1)!.headers.range).toBe("bytes=0-9");
  });

  it("is as strict about where a later hop goes as about the first: https, a public name, no login, no odd port, nothing private", async () => {
    const { fake, hub } = setup();
    for (const to of ["http://storage.example.org/a?hop=1", "https://127.0.0.1/a?hop=1", "https://user:pw@storage.example.org/a?hop=1", "https://storage.example.org:8443/a?hop=1", "https://localhost/a?hop=1", "https://printer.local/a?hop=1", "https://127.0.0.1.nip.io/a?hop=1"]) {
      fake.nodeRedirect = to;
      const before = fake.requests.length;
      const r = await hub.fetchAudio("https://creatornode.audius.co/tracks/cidstream/Qm1");
      expect(r, to).toEqual({ ok: false, error: expect.stringMatching(/will not follow/i) });
      expect(fake.requests.length - before, to).toBe(1); // only the content node itself was asked
    }
  });

  it("still wants the address Audius's own API hands out to be a content node's stream address", async () => {
    const { fake, hub } = setup();
    fake.node = "https://validator.abc.r2.cloudflarestorage.com/28p/QmAbc?hop=1";
    expect((await hub.streamOf("95wro")).ok).toBe(false);
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
