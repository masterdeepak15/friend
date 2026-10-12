import { describe, expect, it } from "vitest";
import { vetVideoUrl } from "./url";

const PRIVATE: Record<string, string[]> = { "127.0.0.1.nip.io": ["127.0.0.1"], "mixed.example.org": ["93.184.216.34", "10.0.0.8"], "v6.example.org": ["::1"], "gone.example.org": [] };
const resolve = async (host: string): Promise<string[]> => PRIVATE[host] ?? ["93.184.216.34"];
const vet = (raw: string, allowedSites: string[] = []) => vetVideoUrl(raw, { resolve, allowedSites });

describe("a link Friend will play", () => {
  it("is an http or https address of a public name, and comes back cleaned", async () => {
    expect(await vet("https://www.youtube.com/watch?v=dQw4w9WgXcQ")).toEqual({ ok: true, url: "https://www.youtube.com/watch?v=dQw4w9WgXcQ", host: "www.youtube.com" });
    expect(await vet("  http://vimeo.com/12345  ")).toMatchObject({ ok: true, url: "http://vimeo.com/12345" });
    expect(await vet("https://youtu.be/abc#t=30")).toMatchObject({ ok: true });
  });

  it("is refused when it is not a web address at all, in one plain sentence", async () => {
    for (const bad of ["", "   ", "youtube", "not a link", "//example.com/x", "x".repeat(2100)]) {
      const r = await vet(bad);
      expect(r.ok, bad).toBe(false);
    }
    expect(await vet("not a link")).toEqual({ ok: false, error: "That is not a web address." });
  });

  it("is refused for anything but http and https", async () => {
    for (const bad of ["file:///C:/Windows/win.ini", "ftp://example.com/v.mp4", "javascript:alert(1)", "data:text/html,x", "rtmp://example.com/live", "smb://host/share", "gopher://example.com"]) {
      expect(await vet(bad), bad).toEqual({ ok: false, error: expect.stringMatching(/only http and https/i) });
    }
  });

  it("is refused with a login in it or on an odd port", async () => {
    expect((await vet("https://user:pass@example.com/v")).ok).toBe(false);
    expect((await vet("https://user@example.com/v")).ok).toBe(false);
    expect((await vet("https://example.com:8443/v")).ok).toBe(false);
    expect((await vet("http://example.com:8080/v")).ok).toBe(false);
    expect((await vet("https://example.com:443/v")).ok).toBe(true);
    expect((await vet("http://example.com:80/v")).ok).toBe(true);
  });

  it("is refused for this PC and the owner's network, by number or by name", async () => {
    for (const bad of ["http://localhost/v", "http://127.0.0.1/v", "http://[::1]/v", "http://192.168.1.5/v", "http://10.0.0.8/v", "http://169.254.169.254/latest/meta-data", "http://0.0.0.0/v", "http://printer.local/v", "http://nas/v", "http://router.lan/v", "http://something.internal/v", "http://2130706433/v", "http://0x7f.0.0.1/v", "https://127.0.0.1.nip.io/v", "https://mixed.example.org/v", "https://v6.example.org/v", "https://gone.example.org/v"]) {
      const r = await vet(bad);
      expect(r.ok, bad).toBe(false);
      expect(JSON.stringify(r), bad).not.toMatch(/169\.254|nip\.io|127\.0\.0\.1/); // the sentence never repeats where it pointed
    }
    expect(await vet("http://localhost/v")).toEqual({ ok: false, error: expect.stringMatching(/this PC or your network/i) });
  });

  it("follows the owner's list of sites when they made one: the site and its sub-domains only", async () => {
    expect((await vet("https://www.youtube.com/watch?v=x", ["youtube.com"])).ok).toBe(true);
    expect((await vet("https://youtube.com/watch?v=x", ["youtube.com"])).ok).toBe(true);
    const r = await vet("https://notyoutube.com/x", ["youtube.com", "vimeo.com"]);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/allowed list.*youtube\.com.*vimeo\.com/i) });
    expect((await vet("https://youtube.com.evil.example/x", ["youtube.com"])).ok).toBe(false);
    expect((await vet("https://anything.example.org/x", [])).ok).toBe(true); // an empty list means any public site
  });

  it("can skip the owner's list for the media addresses a site hands out (they live on other hosts), but never the public-address rule", async () => {
    const r = await vetVideoUrl("https://rr3---sn-abc.googlevideo.com/videoplayback?x=1", { resolve, allowedSites: [], ignoreSites: true });
    expect(r.ok).toBe(true);
    expect((await vetVideoUrl("https://rr3---sn-abc.googlevideo.com/v", { resolve, allowedSites: ["vimeo.com"], ignoreSites: true })).ok).toBe(true);
    expect((await vetVideoUrl("http://127.0.0.1/v", { resolve, allowedSites: [], ignoreSites: true })).ok).toBe(false);
  });
});
