import { loadConfig } from "@friend/server";
import crossSpawn from "cross-spawn";
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import type { IO } from "../cli";
import { daemonCommand, realDeps, running, type DaemonDeps } from "./daemon";

/** Filled in when the program is bundled for npm. */
declare const __FRIEND_VERSION__: string | undefined;

const PACKAGE = "friend-assistant";

/** What the upgrade needs from the outside world; tests replace it. */
export interface UpgradeDeps {
  current(): string;
  /** The newest version on npm, or null when npm could not be asked. */
  latest(): Promise<string | null>;
  /** Installs that version for the whole PC; resolves with npm's exit code. */
  install(version: string): Promise<number>;
  /** Starts the background Friend again, using the newly installed program. */
  startAgain(): Promise<number>;
  daemon: DaemonDeps;
  /** Writes the "start by itself" setup again with the program that was just installed (a no-op when it was never switched on). */
  refreshAutostart?(): Promise<void>;
  /** Where `--auto` writes what happened (a file; tests replace it). */
  log?(line: string): void;
}

const real: UpgradeDeps = {
  current: () => (typeof __FRIEND_VERSION__ === "string" ? __FRIEND_VERSION__ : "development"),
  latest: () =>
    new Promise((resolve) => {
      // --prefer-online: npm keeps a cached list of versions and may not know about the newest one yet
      const child = crossSpawn("npm", ["view", PACKAGE, "version", "--prefer-online"], { stdio: ["ignore", "pipe", "ignore"] });
      let out = "";
      child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
      child.on("error", () => resolve(null));
      child.on("close", (code) => resolve(code === 0 && /^\d+\.\d+\.\d+/.test(out.trim()) ? out.trim().split(/\s+/)[0]! : null));
    }),
  install: (version) =>
    new Promise((resolve) => {
      // the exact version, not "latest", so a stale cache cannot install the old one again
      const child = crossSpawn("npm", ["install", "-g", `${PACKAGE}@${version}`, "--prefer-online"], { stdio: "inherit" });
      child.on("error", () => resolve(1));
      child.on("close", (code) => resolve(code ?? 1));
    }),
  startAgain: () =>
    new Promise((resolve) => {
      const child = crossSpawn("friend", ["daemon", "start"], { stdio: "inherit" });
      child.on("error", () => resolve(1));
      child.on("close", (code) => resolve(code ?? 1));
    }),
  refreshAutostart: () =>
    new Promise<void>((resolve) => {
      const child = crossSpawn("friend", ["autostart", "refresh"], { stdio: "ignore" }); // the new program, not the one that is running this
      child.on("error", () => resolve());
      child.on("close", () => resolve());
    }),
  daemon: realDeps,
};

const newer = (a: string, b: string): boolean => {
  const n = (v: string) => v.split(/[.-]/).slice(0, 3).map((x) => Number(x) || 0);
  const [x, y] = [n(a), n(b)];
  for (let i = 0; i < 3; i++) if ((x[i] ?? 0) !== (y[i] ?? 0)) return (x[i] ?? 0) > (y[i] ?? 0);
  return false;
};

/** `friend upgrade`: stops the background Friend, installs the newest version, and starts it again. `--auto` is how Friend updates itself: the same, with what happened written to update.log. */
export async function upgradeCommand(args: string[], io0: IO, deps: UpgradeDeps = real): Promise<number> {
  const force = args.includes("--force");
  const auto = args.includes("--auto");
  if (args.some((a) => a !== "--force" && a !== "--auto")) {
    io0.err("Usage: friend upgrade [--force] [--auto]");
    return 1;
  }
  const log = deps.log ?? ((line: string) => appendFileSync(join(io0.dataDir, "update.log"), `${new Date().toISOString()} ${line}
`));
  const io: IO = auto
    ? {
        ...io0,
        out: (l) => {
          io0.out(l);
          log(l);
        },
        err: (l) => {
          io0.err(l);
          log(l);
        },
      }
    : io0;
  const current = deps.current();
  io.out(`Installed: ${current}`);
  const latest = await deps.latest();
  if (!latest) {
    io.err("Could not ask npm for the newest version. Check your internet connection and try again.");
    return 1;
  }
  io.out(`Newest:    ${latest}`);
  if (!force && !newer(latest, current)) {
    io.out("Friend is already up to date.");
    return 0;
  }

  const cfg = loadConfig(io.dataDir);
  const wasRunning = running(io.dataDir, deps.daemon) !== null;
  if (wasRunning) {
    io.out("Stopping the background Friend…");
    const code = await daemonCommand(["stop"], io, deps.daemon);
    if (code !== 0) return code;
  } else if (await deps.daemon.portOpen(cfg.port, 500)) {
    io.err(`Friend is running in a terminal (port ${cfg.port} is in use). Press Ctrl+C there to stop it, then run: friend upgrade`);
    return 1;
  }

  io.out(`Installing ${PACKAGE}@${latest}…`);
  const code = await deps.install(latest);
  if (code !== 0) {
    io.err("The install failed. If it says EBUSY or EPERM, close whatever is using Friend (a terminal running it, a voice process) and run: friend upgrade");
    if (wasRunning) await deps.startAgain(); // do not leave it switched off
    return 1;
  }
  io.out(`Upgraded ${current} → ${latest}.`);
  await deps.refreshAutostart?.().catch(() => {});
  if (wasRunning) return deps.startAgain();
  io.out("Start it with: friend start   (or in the background: friend daemon start)");
  return 0;
}
