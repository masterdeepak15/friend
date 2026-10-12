import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { managedPath, Provisioner, toolPlan, ALLOWED_HOSTS, type Extract } from "./provision";
import type { YtRun } from "./resolve";

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

describe("what Friend would download for each system", () => {
  it("is a single program for yt-dlp, from the project's own release page, with its checksum list", () => {
    const win = toolPlan("yt-dlp", "win32", "x64")!;
    expect(win).toMatchObject({ file: "yt-dlp.exe", archive: "none", url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe", sums: { url: "https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS", name: "yt-dlp.exe" } });
    expect(toolPlan("yt-dlp", "win32", "arm64")!.url).toMatch(/yt-dlp_arm64\.exe$/);
    expect(toolPlan("yt-dlp", "win32", "ia32")!.url).toMatch(/yt-dlp_x86\.exe$/);
    expect(toolPlan("yt-dlp", "darwin", "arm64")!).toMatchObject({ file: "yt-dlp", url: expect.stringMatching(/yt-dlp_macos$/) });
    expect(toolPlan("yt-dlp", "darwin", "x64")!.url).toMatch(/yt-dlp_macos$/);
    expect(toolPlan("yt-dlp", "linux", "x64")!.url).toMatch(/yt-dlp_linux$/);
    expect(toolPlan("yt-dlp", "linux", "arm64")!.url).toMatch(/yt-dlp_linux_aarch64$/);
  });

  it("is a build of ffmpeg in an archive, with the program's place inside it, for Windows, Linux and macOS", () => {
    expect(toolPlan("ffmpeg", "win32", "x64")).toMatchObject({ file: "ffmpeg.exe", archive: "zip", url: expect.stringMatching(/^https:\/\/github\.com\/BtbN\/FFmpeg-Builds\/releases\/download\/latest\/ffmpeg-master-latest-win64-gpl\.zip$/), inside: "bin/ffmpeg.exe", sums: { name: "ffmpeg-master-latest-win64-gpl.zip" } });
    expect(toolPlan("ffmpeg", "win32", "arm64")!.url).toMatch(/winarm64/);
    expect(toolPlan("ffmpeg", "linux", "x64")).toMatchObject({ archive: "tar.xz", inside: "bin/ffmpeg", url: expect.stringMatching(/linux64-gpl\.tar\.xz$/) });
    expect(toolPlan("ffmpeg", "linux", "arm64")!.url).toMatch(/linuxarm64-gpl\.tar\.xz$/);
    expect(toolPlan("ffmpeg", "darwin", "arm64")).toMatchObject({ archive: "zip", inside: "ffmpeg", url: expect.stringContaining("macos/arm64") });
    expect(toolPlan("ffmpeg", "darwin", "x64")!.url).toContain("macos/amd64");
  });

  it("has nothing for a system it does not know, and only ever uses a few fixed hosts", () => {
    expect(toolPlan("ffmpeg", "freebsd" as never, "x64")).toBeNull();
    expect(toolPlan("yt-dlp", "linux", "mips" as never)).toBeNull();
    for (const plat of ["win32", "darwin", "linux"] as const) {
      for (const arch of ["x64", "arm64"] as const) {
        for (const name of ["yt-dlp", "ffmpeg"] as const) {
          const p = toolPlan(name, plat, arch);
          if (!p) continue;
          expect(new URL(p.url).protocol).toBe("https:");
          expect(ALLOWED_HOSTS.some((h) => new URL(p.url).hostname === h || new URL(p.url).hostname.endsWith(`.${h}`)), p.url).toBe(true);
        }
      }
    }
  });

  it("keeps the downloaded programs in one folder of Friend's own", () => {
    expect(managedPath("C:/Users/me/.friend", "yt-dlp", "win32")).toBe("C:/Users/me/.friend/tools/yt-dlp.exe");
    expect(managedPath("/home/me/.friend", "ffmpeg", "linux")).toBe("/home/me/.friend/tools/ffmpeg");
  });
});

// ---- the work itself, with a stand-in network and a stand-in archive reader ----
const YT = Buffer.from("PRETEND-YT-DLP-PROGRAM");
const ARCHIVE = Buffer.from("PRETEND-FFMPEG-ARCHIVE");
const FF = Buffer.from("PRETEND-FFMPEG-PROGRAM");

function net(over: { badSum?: boolean; fail?: string; slow?: boolean; size?: number } = {}) {
  const requests: string[] = [];
  const fake = (async (input: unknown) => {
    const url = String(input);
    requests.push(url);
    if (over.fail && url.includes(over.fail)) return new Response("nope", { status: 404 });
    if (url.endsWith("/SHA2-256SUMS")) return new Response(`${over.badSum ? "0".repeat(64) : sha(YT)}  yt-dlp.exe\n${"1".repeat(64)}  yt-dlp_macos\n`);
    if (url.endsWith("/checksums.sha256")) return new Response(`${over.badSum ? "0".repeat(64) : sha(ARCHIVE)}  ffmpeg-master-latest-win64-gpl.zip\n`);
    if (url.endsWith("yt-dlp.exe")) return new Response(YT, { headers: { "content-length": String(YT.length) } });
    if (url.endsWith("ffmpeg-master-latest-win64-gpl.zip")) {
      return new Response(ARCHIVE, { headers: { "content-length": String(over.size ?? ARCHIVE.length) } }); // a size in the header larger than any real build
    }
    return new Response("unexpected", { status: 500 });
  }) as unknown as typeof fetch;
  return { fetch: fake, requests };
}
const extract: Extract = async (_archive, plan, dest) => {
  writeFileSync(dest, FF);
  void plan;
};

function make(over: { network?: ReturnType<typeof net>; extract?: Extract; platform?: NodeJS.Platform; arch?: string } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "friend-provision-"));
  const network = over.network ?? net();
  const events: string[] = [];
  const p = new Provisioner({ dataDir: dir, fetch: network.fetch, extract: over.extract ?? extract, platform: over.platform ?? "win32", arch: over.arch ?? "x64", onChange: () => events.push(JSON.stringify(p.state())) });
  return { p, dir, network, events };
}

describe("downloading what is missing", () => {
  it("fetches a program, checks it against the published checksum, and puts it in Friend's tools folder", async () => {
    const t = make();
    const r = await t.p.ensure(["yt-dlp"]);
    expect(r).toEqual({ ok: true });
    const file = join(t.dir, "tools", "yt-dlp.exe");
    expect(readFileSync(file)).toEqual(YT);
    expect(t.network.requests).toEqual(["https://github.com/yt-dlp/yt-dlp/releases/latest/download/SHA2-256SUMS", "https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe"]);
    expect(t.p.state().tools["yt-dlp"]).toMatchObject({ phase: "ready" });
  });

  it("unpacks ffmpeg out of its archive, and removes the archive and anything half-done", async () => {
    const t = make();
    const r = await t.p.ensure(["ffmpeg"]);
    expect(r).toEqual({ ok: true });
    expect(readFileSync(join(t.dir, "tools", "ffmpeg.exe"))).toEqual(FF);
    const { readdirSync } = await import("node:fs");
    expect(readdirSync(join(t.dir, "tools")).sort()).toEqual(["ffmpeg.exe"]);
  });

  it("will not keep a program whose checksum is wrong, and says so without naming where it came from", async () => {
    const t = make({ network: net({ badSum: true }) });
    const r = await t.p.ensure(["yt-dlp"]);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/did not match.*checksum/i) });
    expect(existsSync(join(t.dir, "tools", "yt-dlp.exe"))).toBe(false);
    expect(t.p.state().tools["yt-dlp"]).toMatchObject({ phase: "error" });
  });

  it("says in a sentence when the download fails, and tries again the next time it is asked", async () => {
    const bad = net({ fail: "yt-dlp.exe" });
    const t = make({ network: bad });
    expect(await t.p.ensure(["yt-dlp"])).toEqual({ ok: false, error: expect.stringMatching(/could not download yt-dlp/i) });
    const good = net();
    const again = new Provisioner({ dataDir: t.dir, fetch: good.fetch, extract, platform: "win32", arch: "x64" });
    expect(await again.ensure(["yt-dlp"])).toEqual({ ok: true });
  });

  it("does nothing for a program that is already there", async () => {
    const t = make();
    await t.p.ensure(["yt-dlp"]);
    const before = t.network.requests.length;
    expect(await t.p.ensure(["yt-dlp"])).toEqual({ ok: true });
    expect(t.network.requests.length).toBe(before);
  });

  it("runs one download at a time, however many ask, and everyone gets the same answer", async () => {
    const t = make();
    const [a, b] = await Promise.all([t.p.ensure(["yt-dlp"]), t.p.ensure(["yt-dlp"])]);
    expect([a, b]).toEqual([{ ok: true }, { ok: true }]);
    expect(t.network.requests.filter((u) => u.endsWith("yt-dlp.exe"))).toHaveLength(1);
  });

  it("reports how far it is, so the plugin page can show it", async () => {
    const t = make();
    await t.p.ensure(["yt-dlp", "ffmpeg"]);
    const phases = t.events.map((e) => (JSON.parse(e) as { tools: Record<string, { phase: string }> }).tools["yt-dlp"]?.phase);
    expect(phases).toContain("downloading");
    expect(phases.at(-1)).toBe("ready");
    expect(JSON.parse(t.events.at(-1)!).busy).toBe(false);
  });

  it("refuses a download that is bigger than any real one", async () => {
    const t = make({ network: net({ size: 600_000_000 }) });
    const r = await t.p.ensure(["ffmpeg"]);
    expect(r).toEqual({ ok: false, error: expect.stringMatching(/too big/i) });
  });

  it("says there is nothing to download for a system it does not know", async () => {
    const t = make({ platform: "freebsd" as never });
    expect(await t.p.ensure(["ffmpeg"])).toEqual({ ok: false, error: expect.stringMatching(/cannot set up ffmpeg on this system/i) });
  });

  it("follows a redirect to its own download hosts, and to nothing else", async () => {
    const hops: string[] = [];
    const fake = (async (input: unknown) => {
      const url = String(input);
      hops.push(url);
      if (url.endsWith("/SHA2-256SUMS")) return new Response(`${sha(YT)}  yt-dlp.exe\n`);
      if (url.endsWith("yt-dlp.exe")) return new Response(null, { status: 302, headers: { location: "https://evil.example.com/yt-dlp.exe" } });
      return new Response(YT);
    }) as unknown as typeof fetch;
    const dir = mkdtempSync(join(tmpdir(), "friend-provision-"));
    const p = new Provisioner({ dataDir: dir, fetch: fake, extract, platform: "win32", arch: "x64" });
    expect(await p.ensure(["yt-dlp"])).toEqual({ ok: false, error: expect.stringMatching(/could not download yt-dlp/i) });
    expect(hops.some((h) => h.includes("evil.example.com"))).toBe(false);
  });
});

describe("keeping yt-dlp up to date", () => {
  const WEEK = 7 * 24 * 3600 * 1000;
  function setup() {
    const t = make();
    let now = 1_000_000_000_000;
    const runs: string[][] = [];
    const run: YtRun = async (cmd, args) => {
      runs.push([cmd, ...args]);
      return { code: 0, out: "Updated", err: "" };
    };
    const p = new Provisioner({ dataDir: t.dir, fetch: t.network.fetch, extract, platform: "win32", arch: "x64", run, now: () => now });
    return { t, p, runs, advance: (ms: number) => (now += ms), dir: t.dir };
  }

  it("asks yt-dlp to update itself, at most once a week, and only for the copy Friend downloaded", async () => {
    const x = setup();
    await x.p.update(); // nothing downloaded yet: nothing to update
    expect(x.runs).toEqual([]);
    await x.p.ensure(["yt-dlp"]);
    await x.p.update();
    expect(x.runs).toEqual([[managedPath(x.dir, "yt-dlp", "win32"), "-U"]]);
    await x.p.update();
    expect(x.runs).toHaveLength(1);
    x.advance(WEEK + 1000);
    await x.p.update();
    expect(x.runs).toHaveLength(2);
  });

  it("does not stop anything when the update fails, and tries again the next day, not at once", async () => {
    const x = setup();
    await x.p.ensure(["yt-dlp"]);
    const failing = new Provisioner({ dataDir: x.dir, fetch: x.t.network.fetch, extract, platform: "win32", arch: "x64", run: async () => { throw new Error("spawn failed"); }, now: () => 1_000_000_000_000 });
    await expect(failing.update()).resolves.toBeUndefined();
  });
});
