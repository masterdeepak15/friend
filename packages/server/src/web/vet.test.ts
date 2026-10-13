import { describe, expect, it } from "vitest";
import { vetPublicUrl } from "../video/url";

const resolveTo = (...addresses: string[]) => async () => addresses;
const ok = (url: string, ...addr: string[]) => vetPublicUrl(url, { resolve: resolveTo(...(addr.length ? addr : ["93.184.216.34"])) });

describe("which web pages Friend may fetch", () => {
  it("accepts a plain https page of a public name", async () => {
    expect(await ok("https://example.com/a?b=1")).toEqual({ ok: true, url: "https://example.com/a?b=1", host: "example.com" });
    expect(await ok("http://news.example.co.in/x")).toMatchObject({ ok: true, host: "news.example.co.in" });
  });

  it("refuses anything that is not http or https", async () => {
    for (const u of ["ftp://example.com/a", "file:///C:/secret.txt", "javascript:alert(1)", "data:text/html,hi", "gopher://example.com"]) {
      expect(await ok(u), u).toMatchObject({ ok: false });
    }
  });

  it("refuses a login in the link, an odd port, and things that are not addresses", async () => {
    for (const u of ["https://user:pw@example.com/", "https://example.com:8080/", "not a link", "", "https://", "https:///x"]) {
      expect(await ok(u), u).toMatchObject({ ok: false });
    }
    expect(await vetPublicUrl("https://example.com/" + "a".repeat(2000))).toMatchObject({ ok: false });
  });

  it("refuses this PC, the home network, and names that only work inside one", async () => {
    for (const u of ["http://localhost/", "http://127.0.0.1/", "http://[::1]/", "http://192.168.1.1/", "http://169.254.169.254/latest/meta-data", "http://router.local/", "http://nas.lan/", "http://intranet.corp/", "http://a.internal/", "http://2130706433/"]) {
      expect(await ok(u), u).toMatchObject({ ok: false });
    }
  });

  it("refuses a public-looking name that really points inside, whatever the address is", async () => {
    for (const a of ["127.0.0.1", "10.0.0.5", "172.16.3.4", "192.168.0.9", "169.254.169.254", "::1", "fd00::1", "fe80::1"]) {
      expect(await ok("https://sneaky.example.com/", a), a).toMatchObject({ ok: false });
    }
    expect(await ok("https://mixed.example.com/", "93.184.216.34", "10.0.0.5")).toMatchObject({ ok: false });
  });

  it("gives the same sentence for every way of pointing inside, and never repeats the address", async () => {
    const said = new Set<string>();
    for (const [u, a] of [["http://127.0.0.1/", []], ["http://192.168.1.50/x", []], ["http://nas.lan/", []], ["https://sneaky.example.com/", ["10.9.8.7"]]] as [string, string[]][]) {
      const r = await ok(u, ...a);
      expect(r.ok).toBe(false);
      if (!r.ok) {
        said.add(r.error);
        expect(r.error).not.toMatch(/127\.0|192\.168|10\.9|nas\.lan|sneaky/);
      }
    }
    expect(said.size).toBe(1);
  });

  it("talks about pages, not videos", async () => {
    const r = await ok("ftp://example.com/a");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toMatch(/video|played|play/i);
  });

  it("says when the site cannot be found", async () => {
    const r = await vetPublicUrl("https://nope.example.com/", {
      resolve: async () => {
        throw new Error("ENOTFOUND");
      },
    });
    expect(r).toEqual({ ok: false, error: "Friend could not find that site." });
  });
});
