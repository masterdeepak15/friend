import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { chmodSync, createWriteStream, existsSync, mkdirSync, readdirSync, renameSync, rmSync, copyFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ytRun, type YtRun } from "./resolve";

export type ToolName = "yt-dlp" | "ffmpeg";

/** The only hosts Friend downloads from: the projects' own release pages and one macOS build site. Nothing else, however a link redirects. */
export const ALLOWED_HOSTS = ["github.com", "githubusercontent.com", "ffmpeg.martin-riedl.de"];

export interface ToolPlan {
  name: ToolName;
  /** The program's file name in Friend's tools folder. */
  file: string;
  url: string;
  archive: "none" | "zip" | "tar.xz";
  /** Where the program is inside the archive (the folder the archive starts with is skipped). */
  inside?: string;
  /** The published list of checksums, and the name this download has in it. */
  sums: { url: string; name: string };
}

const YT = "https://github.com/yt-dlp/yt-dlp/releases/latest/download";
const BTBN = "https://github.com/BtbN/FFmpeg-Builds/releases/download/latest";
const RIEDL = "https://ffmpeg.martin-riedl.de/redirect/latest/macos";

/** What to download for one program on one system, or null when there is nothing for that system. */
export function toolPlan(name: ToolName, platform: NodeJS.Platform, arch: string): ToolPlan | null {
  const win = platform === "win32";
  if (name === "yt-dlp") {
    let asset: string | null = null;
    if (win) asset = arch === "x64" ? "yt-dlp.exe" : arch === "arm64" ? "yt-dlp_arm64.exe" : arch === "ia32" ? "yt-dlp_x86.exe" : null;
    else if (platform === "darwin") asset = arch === "x64" || arch === "arm64" ? "yt-dlp_macos" : null;
    else if (platform === "linux") asset = arch === "x64" ? "yt-dlp_linux" : arch === "arm64" ? "yt-dlp_linux_aarch64" : null;
    return asset ? { name, file: win ? "yt-dlp.exe" : "yt-dlp", url: `${YT}/${asset}`, archive: "none", sums: { url: `${YT}/SHA2-256SUMS`, name: asset } } : null;
  }
  if (platform === "darwin") {
    const a = arch === "arm64" ? "arm64" : arch === "x64" ? "amd64" : null;
    if (!a) return null;
    const url = `${RIEDL}/${a}/release/ffmpeg.zip`;
    return { name, file: "ffmpeg", url, archive: "zip", inside: "ffmpeg", sums: { url: `${url}.sha256`, name: "ffmpeg.zip" } };
  }
  const build = win ? (arch === "x64" ? "win64" : arch === "arm64" ? "winarm64" : null) : platform === "linux" ? (arch === "x64" ? "linux64" : arch === "arm64" ? "linuxarm64" : null) : null;
  if (!build) return null;
  const archive = win ? "zip" : "tar.xz";
  const file = `ffmpeg-master-latest-${build}-gpl.${archive}`;
  return { name, file: win ? "ffmpeg.exe" : "ffmpeg", url: `${BTBN}/${file}`, archive, inside: win ? "bin/ffmpeg.exe" : "bin/ffmpeg", sums: { url: `${BTBN}/checksums.sha256`, name: file } };
}

/** Where Friend keeps the programs it downloaded. */
export function managedPath(dataDir: string, name: ToolName, platform: NodeJS.Platform = process.platform): string {
  return `${dataDir.replace(/[\\/]+$/, "")}/tools/${name}${platform === "win32" ? ".exe" : ""}`;
}

export type Extract = (archivePath: string, plan: ToolPlan, dest: string) => Promise<void>;

export type ToolPhase = { phase: "idle" } | { phase: "downloading"; percent: number | null } | { phase: "unpacking" } | { phase: "ready" } | { phase: "error"; error: string };

export interface ProvisionDeps {
  dataDir: string;
  fetch?: typeof fetch;
  extract?: Extract;
  platform?: NodeJS.Platform;
  arch?: string;
  /** Called whenever the progress changes. */
  onChange?: () => void;
  /** Runs yt-dlp to update itself (tests). */
  run?: YtRun;
  now?: () => number;
}

const MAX_BYTES = 500_000_000;
const MAX_HOPS = 5;
const hostOk = (host: string) => ALLOWED_HOSTS.some((h) => host === h || host.endsWith(`.${h}`));

/** Unpacks one program from a zip or tar.xz with the system's own tar (Windows 10 and later, macOS and Linux all have one). */
export const tarExtract: Extract = (archive, plan, dest) =>
  new Promise((resolve, reject) => {
    const tmp = `${dest}.extract-${randomBytes(4).toString("hex")}`;
    mkdirSync(tmp, { recursive: true });
    const done = (err?: Error) => {
      if (!err) {
        try {
          const found = findInside(tmp, plan.inside ?? plan.file);
          if (!found) err = new Error("The program was not in the archive.");
          else copyFileSync(found, dest);
        } catch (e) {
          err = e as Error;
        }
      }
      rmSync(tmp, { recursive: true, force: true });
      return err ? reject(err) : resolve();
    };
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn("tar", ["-xf", archive, "-C", tmp], { stdio: "ignore", windowsHide: true });
    } catch (e) {
      return done(e as Error);
    }
    child.on("error", done);
    child.on("close", (code) => done(code === 0 ? undefined : new Error("tar failed")));
  });

function findInside(root: string, inside: string): string | null {
  const want = `/${inside.replace(/\\/g, "/")}`;
  const walk = (dir: string): string | null => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) {
        const r = walk(p);
        if (r) return r;
      } else if (`/${p.slice(root.length).replace(/\\/g, "/").replace(/^\//, "")}`.endsWith(want) || (!inside.includes("/") && e.name === inside)) return p;
    }
    return null;
  };
  return walk(root);
}

/** The checksum for one file from a published list ("hash  name" per line, or a file holding just the hash). */
function checksumFor(list: string, name: string): string | null {
  const lines = list.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  for (const l of lines) {
    const m = /^([0-9a-fA-F]{64})\s+\*?(.+)$/.exec(l);
    if (m && m[2]!.trim() === name) return m[1]!.toLowerCase();
  }
  if (lines.length === 1 && /^[0-9a-fA-F]{64}$/.test(lines[0]!)) return lines[0]!.toLowerCase();
  return null;
}

/**
 * Gets the helper programs web video needs (yt-dlp and ffmpeg) by itself, so the owner installs nothing: each is downloaded from its
 * project's own release page over https, checked against the published SHA-256, and kept in Friend's own tools folder. One download
 * at a time; asking again for something already there does nothing.
 */
export class Provisioner {
  private tools: Partial<Record<ToolName, ToolPhase>> = {};
  private running: Promise<unknown> | null = null;
  private platform: NodeJS.Platform;
  private arch: string;

  constructor(private d: ProvisionDeps) {
    this.platform = d.platform ?? process.platform;
    this.arch = d.arch ?? process.arch;
  }

  state(): { busy: boolean; tools: Partial<Record<ToolName, ToolPhase>> } {
    return { busy: this.running !== null, tools: { ...this.tools } };
  }

  private set(name: ToolName, phase: ToolPhase): void {
    this.tools[name] = phase;
    this.d.onChange?.();
  }

  /**
   * Sites change often and an old yt-dlp stops working, so the copy Friend downloaded is asked to update itself (its own `-U`) when
   * a week has passed. A failure is nothing to stop for: it is tried again later.
   */
  async update(): Promise<void> {
    const file = managedPath(this.d.dataDir, "yt-dlp", this.platform);
    if (!existsSync(file)) return;
    const stamp = join(this.d.dataDir, "tools", ".yt-dlp-updated");
    const now = (this.d.now ?? Date.now)();
    const WEEK = 7 * 24 * 3600 * 1000;
    if (existsSync(stamp) && now - statSync(stamp).mtimeMs < WEEK) return;
    try {
      writeFileSync(stamp, "");
      utimesSync(stamp, now / 1000, now / 1000); // marked first: a failing update is not tried again at once
      await (this.d.run ?? ytRun)(file, ["-U"], { timeoutMs: 120_000, maxBytes: 100_000 });
    } catch {
      /* the old copy still works; the next week tries again */
    }
  }

  private has(name: ToolName): boolean {
    return existsSync(managedPath(this.d.dataDir, name, this.platform));
  }

  async ensure(names: ToolName[]): Promise<{ ok: true } | { ok: false; error: string }> {
    while (this.running) await this.running.catch(() => {});
    const job = (async (): Promise<{ ok: true } | { ok: false; error: string }> => {
      for (const name of names) {
        if (this.has(name)) {
          this.set(name, { phase: "ready" });
          continue;
        }
        const r = await this.get(name);
        if (!r.ok) return r;
      }
      return { ok: true };
    })();
    this.running = job;
    try {
      return await job;
    } finally {
      this.running = null;
      this.d.onChange?.();
    }
  }

  private async get(name: ToolName): Promise<{ ok: true } | { ok: false; error: string }> {
    const plan = toolPlan(name, this.platform, this.arch);
    const fail = (error: string) => {
      this.set(name, { phase: "error", error });
      return { ok: false as const, error };
    };
    if (!plan) return fail(`Friend cannot set up ${name} on this system by itself. Install it with your package manager, then press Check again.`);
    const tools = join(this.d.dataDir, "tools");
    mkdirSync(tools, { recursive: true });
    const part = join(tools, `.download-${name}-${randomBytes(4).toString("hex")}`);
    const final = managedPath(this.d.dataDir, name, this.platform);
    try {
      this.set(name, { phase: "downloading", percent: null });
      const list = await this.text(plan.sums.url);
      const want = checksumFor(list, plan.sums.name);
      if (!want) return fail(`Friend could not check the ${name} download: no published checksum was found for it.`);
      const got = await this.file(plan.url, part, (percent) => this.set(name, { phase: "downloading", percent }));
      if (got.error) return fail(got.error === "big" ? `The download of ${name} is too big to be right, so Friend stopped.` : `Friend could not download ${name}. Check the internet connection and try again.`);
      if (got.sha !== want) return fail(`The ${name} that was downloaded did not match its published checksum, so Friend threw it away.`);
      if (plan.archive === "none") {
        renameSync(part, final);
      } else {
        this.set(name, { phase: "unpacking" });
        await (this.d.extract ?? tarExtract)(part, plan, final);
      }
      if (this.platform !== "win32") chmodSync(final, 0o755);
      this.set(name, { phase: "ready" });
      return { ok: true };
    } catch {
      rmSync(final, { force: true });
      return fail(`Friend could not download ${name}. Check the internet connection and try again.`);
    } finally {
      rmSync(part, { force: true });
    }
  }

  /** One address, following redirects only to Friend's own download hosts. */
  private async open(url: string): Promise<Response> {
    const f = this.d.fetch ?? fetch;
    let next = url;
    for (let hop = 0; hop <= MAX_HOPS; hop++) {
      const u = new URL(next);
      if (u.protocol !== "https:" || !hostOk(u.hostname.toLowerCase())) throw new Error("host");
      const res = await f(next, { redirect: "manual" });
      if (res.status >= 300 && res.status < 400) {
        void res.body?.cancel().catch(() => {});
        const loc = res.headers.get("location");
        if (!loc) throw new Error("redirect");
        next = new URL(loc, next).toString();
        continue;
      }
      if (!res.ok) {
        void res.body?.cancel().catch(() => {});
        throw new Error("status");
      }
      return res;
    }
    throw new Error("hops");
  }

  private async text(url: string): Promise<string> {
    const res = await this.open(url);
    return (await res.text()).slice(0, 2_000_000);
  }

  private async file(url: string, dest: string, progress: (percent: number | null) => void): Promise<{ sha: string; error?: undefined } | { sha?: undefined; error: "big" | "failed" }> {
    let res: Response;
    try {
      res = await this.open(url);
    } catch {
      return { error: "failed" };
    }
    const total = Number(res.headers.get("content-length") ?? 0);
    if (total > MAX_BYTES) {
      void res.body?.cancel().catch(() => {});
      return { error: "big" };
    }
    if (!res.body) return { error: "failed" };
    const hash = createHash("sha256");
    const out = createWriteStream(dest);
    let received = 0;
    let lastPercent = -1;
    try {
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        received += value.length;
        if (received > MAX_BYTES) {
          await reader.cancel().catch(() => {});
          out.destroy();
          return { error: "big" };
        }
        hash.update(value);
        if (!out.write(value)) await new Promise<void>((r) => out.once("drain", () => r()));
        const percent = total > 0 ? Math.min(99, Math.floor((received / total) * 100)) : null;
        if (percent !== lastPercent) {
          lastPercent = percent ?? -1;
          progress(percent);
        }
      }
      await new Promise<void>((resolve, reject) => {
        out.end(() => resolve());
        out.on("error", reject);
      });
    } catch {
      out.destroy();
      return { error: "failed" };
    }
    if (!existsSync(dest) || statSync(dest).size === 0) return { error: "failed" };
    return { sha: hash.digest("hex") };
  }
}
