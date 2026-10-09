import { loadConfig } from "@friend/server";
import { spawn, spawnSync } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { join } from "node:path";
import type { IO } from "../cli";
import { urlsFor } from "./lan";

const USAGE = "Usage: friend daemon start | stop | restart | status";
const MAX_LOG_BYTES = 5 * 1024 * 1024;

interface PidRecord {
  pid: number;
  startedAt: number;
}

/** What the daemon commands need from the operating system; tests replace it. */
export interface DaemonDeps {
  /** Starts `friend start` detached from this terminal, writing its output to the log file; returns its process id. */
  launch(logFile: string): number | undefined;
  alive(pid: number): boolean;
  /** Ends the process and everything it started. Resolves once it is gone or the time is up. */
  kill(pid: number): Promise<void>;
  /** True when something accepts connections on the port within the time. */
  portOpen(port: number, withinMs: number): Promise<boolean>;
  now(): number;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const realDeps: DaemonDeps = {
  launch(logFile) {
    const fd = openSync(logFile, "a");
    try {
      const child = spawn(process.execPath, [process.argv[1]!, "start"], { detached: true, stdio: ["ignore", fd, fd], windowsHide: true });
      child.unref();
      return child.pid;
    } finally {
      closeSync(fd);
    }
  },
  alive(pid) {
    try {
      process.kill(pid, 0);
      return true;
    } catch (e) {
      return (e as NodeJS.ErrnoException).code === "EPERM"; // exists, but is not ours to signal
    }
  },
  async kill(pid) {
    if (process.platform === "win32") {
      spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
    } else {
      try {
        process.kill(pid, "SIGTERM"); // lets Friend close its connections and the speech engine
      } catch {
        return;
      }
      for (let i = 0; i < 40 && realDeps.alive(pid); i++) await sleep(200);
      if (realDeps.alive(pid)) {
        try {
          process.kill(pid, "SIGKILL");
        } catch {
          /* already gone */
        }
      }
    }
    for (let i = 0; i < 25 && realDeps.alive(pid); i++) await sleep(200);
  },
  portOpen(port, withinMs) {
    return new Promise((resolve) => {
      const s = connect({ port, host: "127.0.0.1" });
      const done = (ok: boolean) => {
        s.destroy();
        resolve(ok);
      };
      s.setTimeout(withinMs, () => done(false));
      s.once("connect", () => done(true));
      s.once("error", () => done(false));
    });
  },
  now: Date.now,
};

const pidFile = (dataDir: string) => join(dataDir, "friend.pid");
export const logFileOf = (dataDir: string) => join(dataDir, "friend.log");

function readPid(dataDir: string): PidRecord | null {
  try {
    const r = JSON.parse(readFileSync(pidFile(dataDir), "utf8")) as PidRecord;
    return Number.isInteger(r.pid) && r.pid > 0 ? r : null;
  } catch {
    return null;
  }
}

/** The background Friend of this data folder, or null (a pid file left by a crash or reboot is cleaned up). */
function running(dataDir: string, deps: DaemonDeps): PidRecord | null {
  const r = readPid(dataDir);
  if (r && deps.alive(r.pid)) return r;
  if (r) rmSync(pidFile(dataDir), { force: true });
  return null;
}

function since(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 90) return `${s} seconds`;
  if (s < 5400) return `${Math.round(s / 60)} minutes`;
  if (s < 129600) return `${Math.round(s / 3600)} hours`;
  return `${Math.round(s / 86400)} days`;
}

async function start(io: IO, deps: DaemonDeps): Promise<number> {
  const existing = running(io.dataDir, deps);
  const cfg = loadConfig(io.dataDir);
  const urls = urlsFor(cfg.bind, cfg.port, undefined, cfg.https);
  if (existing) {
    io.out(`Friend is already running in the background (pid ${existing.pid}) at ${urls.local}`);
    return 0;
  }
  if (await deps.portOpen(cfg.port, 500)) {
    io.err(`Port ${cfg.port} is already in use. Friend may be running in a terminal (stop it with Ctrl+C), or another program uses that port (friend lan port N).`);
    return 1;
  }
  mkdirSync(io.dataDir, { recursive: true });
  const log = logFileOf(io.dataDir);
  try {
    if (existsSync(log) && statSync(log).size > MAX_LOG_BYTES) renameSync(log, `${log}.old`);
  } catch {
    /* keep appending */
  }
  const pid = deps.launch(log);
  if (!pid) {
    io.err("Could not start Friend in the background.");
    return 1;
  }
  writeFileSync(pidFile(io.dataDir), JSON.stringify({ pid, startedAt: deps.now() } satisfies PidRecord));
  for (let i = 0; i < 60; i++) {
    if (await deps.portOpen(cfg.port, 300)) {
      io.out(`Friend is running in the background (pid ${pid}) at ${urls.local}`);
      for (const n of urls.network) io.out(`Also on your network: ${n}`);
      io.out(`Stop it with: friend daemon stop   (log: ${log})`);
      return 0;
    }
    if (!deps.alive(pid)) break;
    await sleep(250);
  }
  rmSync(pidFile(io.dataDir), { force: true });
  io.err(`Friend did not start. See the log: ${log}`);
  return 1;
}

async function stop(io: IO, deps: DaemonDeps): Promise<number> {
  const r = running(io.dataDir, deps);
  if (!r) {
    io.out("Friend is not running in the background.");
    return 0;
  }
  await deps.kill(r.pid);
  if (deps.alive(r.pid)) {
    io.err(`Could not stop Friend (pid ${r.pid}). End that process yourself.`);
    return 1;
  }
  rmSync(pidFile(io.dataDir), { force: true });
  io.out("Friend stopped.");
  return 0;
}

async function status(io: IO, deps: DaemonDeps): Promise<number> {
  const cfg = loadConfig(io.dataDir);
  const urls = urlsFor(cfg.bind, cfg.port, undefined, cfg.https);
  const r = running(io.dataDir, deps);
  if (r) {
    io.out(`Friend is running in the background (pid ${r.pid}, for ${since(deps.now() - r.startedAt)}).`);
    io.out(`Address: ${urls.local}`);
    for (const n of urls.network) io.out(`Also on your network: ${n}`);
    io.out(`Log: ${logFileOf(io.dataDir)}`);
    return 0;
  }
  if (await deps.portOpen(cfg.port, 500)) io.out(`Friend is not running in the background, but port ${cfg.port} is in use. It may be running in a terminal.`);
  else io.out("Friend is not running. Start it in the background with: friend daemon start");
  return 1;
}

export async function daemonCommand(args: string[], io: IO, deps: DaemonDeps = realDeps): Promise<number> {
  switch (args[0]) {
    case "start":
      return start(io, deps);
    case "stop":
      return stop(io, deps);
    case "restart": {
      const code = await stop(io, deps);
      return code === 0 ? start(io, deps) : code;
    }
    case "status":
      return status(io, deps);
    default:
      io.err(USAGE);
      return 1;
  }
}
