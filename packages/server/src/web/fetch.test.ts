import { describe, expect, it } from "vitest";
import { guardedLookup, safeFetch } from "./fetch";

const PUBLIC = "93.184.216.34";
type Handler = (url: string, init: RequestInit) => Response | Promise<Response>;

/** A web made of a function: every request goes to it, and every address it is asked about is recorded. */
function web(handler: Handler, resolve: (host: string) => string[] = () => [PUBLIC]) {
  const asked: string[] = [];
  const inits: RequestInit[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    asked.push(url);
    inits.push(init ?? {});
    return handler(url, init ?? {});
  }) as typeof fetch;
  return { asked, inits, opts: { fetchImpl, resolve: async (h: string) => resolve(h) } };
}
const html = (body: string, type = "text/html; charset=utf-8", status = 200) => new Response(body, { status, headers: { "content-type": type } });
const redirect = (to: string, status = 302) => new Response(null, { status, headers: { location: to } });

describe("fetching a page safely", () => {
  it("returns the page, where it ended up, and its type", async () => {
    const w = web(() => html("<h1>Hello</h1>"));
    const r = await safeFetch("https://example.com/a", w.opts);
    expect(r).toEqual({ ok: true, finalUrl: "https://example.com/a", contentType: "text/html", body: "<h1>Hello</h1>" });
  });

  it("follows a redirect to another public page, including a relative one", async () => {
    const w = web((u) => (u === "https://example.com/a" ? redirect("/b") : u === "https://example.com/b" ? redirect("https://other.example.org/c", 301) : html("done")));
    const r = await safeFetch("https://example.com/a", w.opts);
    expect(r).toMatchObject({ ok: true, finalUrl: "https://other.example.org/c", body: "done" });
    expect(w.asked).toEqual(["https://example.com/a", "https://example.com/b", "https://other.example.org/c"]);
  });

  it("refuses a link that points inside before sending anything", async () => {
    const w = web(() => html("secret"));
    for (const u of ["http://127.0.0.1/admin", "http://169.254.169.254/latest/meta-data/", "http://192.168.1.1/", "http://localhost:8787/api/session"]) {
      const r = await safeFetch(u, w.opts);
      expect(r.ok, u).toBe(false);
    }
    expect(w.asked).toEqual([]);
  });

  it("refuses a redirect to a name that resolves inside, and never sends that request", async () => {
    const w = web(
      (u) => (u === "https://example.com/a" ? redirect("https://evil.example.net/x") : html("secret")),
      (h) => (h === "evil.example.net" ? ["10.0.0.5"] : [PUBLIC]),
    );
    const r = await safeFetch("https://example.com/a", w.opts);
    expect(r).toMatchObject({ ok: false });
    expect(w.asked).toEqual(["https://example.com/a"]);
  });

  it("refuses a redirect straight to this PC or the cloud metadata address", async () => {
    for (const to of ["http://127.0.0.1:8787/api/setup", "http://169.254.169.254/latest/", "http://[::1]/", "file:///C:/Windows/win.ini"]) {
      const w = web((u) => (u === "https://example.com/a" ? redirect(to) : html("secret")));
      const r = await safeFetch("https://example.com/a", w.opts);
      expect(r.ok, to).toBe(false);
      expect(w.asked, to).toEqual(["https://example.com/a"]);
    }
  });

  it("allows four redirects and refuses the fifth", async () => {
    const chain = (n: number) => web((u) => {
      const i = Number(u.split("/").pop());
      return i < n ? redirect(`/${i + 1}`) : html("end");
    });
    expect(await safeFetch("https://example.com/0", chain(4).opts)).toMatchObject({ ok: true, body: "end" });
    const five = chain(5);
    const r = await safeFetch("https://example.com/0", five.opts);
    expect(r).toMatchObject({ ok: false });
    expect(five.asked).toHaveLength(5);
  });

  it("stops reading a page that never ends once it has enough", async () => {
    let sent = 0;
    const endless = () =>
      new Response(
        new ReadableStream({
          pull(c) {
            sent += 1000;
            c.enqueue(new TextEncoder().encode("a".repeat(1000)));
          },
        }),
        { headers: { "content-type": "text/plain" } },
      );
    const w = web(endless);
    const r = await safeFetch("https://example.com/big", { ...w.opts, maxBytes: 5000 });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.body.length).toBeLessThanOrEqual(5000);
    expect(sent).toBeLessThan(20_000);
  });

  it("takes text and web pages, and nothing else", async () => {
    for (const type of ["text/html", "application/xhtml+xml; charset=utf-8", "text/plain"]) {
      expect((await safeFetch("https://example.com/", web(() => html("x", type)).opts)).ok, type).toBe(true);
    }
    for (const type of ["application/pdf", "image/png", "application/octet-stream", "video/mp4", "application/json"]) {
      expect((await safeFetch("https://example.com/", web(() => html("x", type)).opts)).ok, type).toBe(false);
    }
    expect((await safeFetch("https://example.com/", web(() => new Response(new Uint8Array([120]))).opts)).ok).toBe(false);
  });

  it("gives up on a site that does not answer", async () => {
    const w = web((_u, init) => new Promise<Response>((_res, rej) => init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError")))));
    const started = Date.now();
    const r = await safeFetch("https://example.com/slow", { ...w.opts, timeoutMs: 80 });
    expect(r).toMatchObject({ ok: false, error: expect.stringMatching(/too long/i) });
    expect(Date.now() - started).toBeLessThan(2000);
  });

  it("stops when the caller stops", async () => {
    const ctl = new AbortController();
    const w = web((_u, init) => new Promise<Response>((_res, rej) => (init.signal?.aborted ? rej(new DOMException("aborted", "AbortError")) : init.signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))))));
    const p = safeFetch("https://example.com/slow", { ...w.opts, signal: ctl.signal });
    ctl.abort();
    expect(await p).toMatchObject({ ok: false });
  });

  it("introduces itself plainly and sends no cookies or logins", async () => {
    const w = web(() => html("x"));
    await safeFetch("https://example.com/", w.opts);
    const init = w.inits[0]!;
    const headers = new Headers(init.headers);
    expect(headers.get("user-agent")).toMatch(/^Friend/);
    expect(headers.get("cookie")).toBeNull();
    expect(headers.get("authorization")).toBeNull();
    expect(init.credentials).toBe("omit");
    expect(init.redirect).toBe("manual");
  });

  it("says plainly what went wrong, without the address", async () => {
    const said = [
      await safeFetch("https://example.com/missing", web(() => html("nope", "text/html", 404)).opts),
      await safeFetch("https://example.com/boom", web(() => html("nope", "text/html", 500)).opts),
      await safeFetch("https://example.com/down", web(() => Promise.reject(new TypeError("fetch failed: ECONNREFUSED 10.1.2.3:443"))).opts),
    ];
    for (const r of said) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toMatch(/example\.com|10\.1\.2\.3|ECONNREFUSED/);
    }
  });

  it("decodes the page in the language it declares", async () => {
    const bytes = new TextEncoder().encode("नमस्ते ₹100");
    const w = web(() => new Response(bytes, { headers: { "content-type": "text/html; charset=utf-8" } }));
    expect(await safeFetch("https://example.com/", w.opts)).toMatchObject({ body: "नमस्ते ₹100" });
  });
});

describe("the address that is really connected to", () => {
  const ask = (lookup: ReturnType<typeof guardedLookup>, host: string, opts: object = {}) =>
    new Promise<{ err: Error | null; address: unknown; family?: number }>((resolve) => lookup(host, opts, (err: Error | null, address: unknown, family?: number) => resolve({ err, address, family })));

  it("hands over a public address", async () => {
    const r = await ask(guardedLookup(async () => [{ address: "93.184.216.34", family: 4 }]), "example.com");
    expect(r).toEqual({ err: null, address: "93.184.216.34", family: 4 });
  });

  it("hands over every public address when asked for all of them", async () => {
    const r = await ask(guardedLookup(async () => [{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]), "example.com", { all: true });
    expect(r.err).toBeNull();
    expect(r.address).toEqual([{ address: "93.184.216.34", family: 4 }, { address: "2606:2800:220:1:248:1893:25c8:1946", family: 6 }]);
  });

  it("refuses a name that now points inside, even if it did not a moment ago", async () => {
    for (const a of ["127.0.0.1", "10.1.2.3", "192.168.0.1", "169.254.169.254", "::1"]) {
      const r = await ask(guardedLookup(async () => [{ address: a, family: a.includes(":") ? 6 : 4 }]), "rebind.example.com");
      expect(r.err, a).toBeInstanceOf(Error);
      expect(String(r.err?.message), a).not.toContain(a);
    }
  });

  it("refuses when any one of the addresses is inside", async () => {
    const r = await ask(guardedLookup(async () => [{ address: "93.184.216.34", family: 4 }, { address: "10.0.0.5", family: 4 }]), "mixed.example.com", { all: true });
    expect(r.err).toBeInstanceOf(Error);
  });

  it("fails clearly when the name cannot be found", async () => {
    const r = await ask(guardedLookup(async () => { throw new Error("ENOTFOUND"); }), "nope.example.com");
    expect(r.err).toBeInstanceOf(Error);
  });
});
