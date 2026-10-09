import { loadConfig } from "@friend/server";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IO } from "./cli";
import { daemonCommand, type DaemonDeps } from "./commands/daemon";

function setup() {
  const out: string[] = [];
  const err: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), "friend-daemon-"));
  const io: IO = { dataDir, out: (l) => out.push(l), err: (l) => err.push(l), ask: async () => "" };
  const port = loadConfig(dataDir).port;
  // a pretend operating system: one process list, and a port that opens when Friend is "running"
  const procs = new Set<number>();
  let next = 4000;
  let listening = false;
  let launchCrashes = false;
  const deps: DaemonDeps = {
    launch: (log) => {
      writeFileSync(log, "");
      const pid = next++;
      if (!launchCrashes) {
        procs.add(pid);
        listening = true;
      }
      return pid;
    },
    alive: (pid) => procs.has(pid),
    kill: async (pid) => {
      procs.delete(pid);
      listening = false;
    },
    portOpen: async () => listening,
    now: () => 1_000_000,
  };
  return { io, out, err, dataDir, port, deps, procs, crash: () => (launchCrashes = true), text: () => out.join("\n"), pidFile: () => join(dataDir, "friend.pid") };
}

describe("friend daemon", () => {
  it("start runs Friend in the background, prints the address and remembers the process", async () => {
    const t = setup();
    expect(await daemonCommand(["start"], t.io, t.deps)).toBe(0);
    expect(t.text()).toMatch(/running in the background \(pid 4000\) at http:\/\/127\.0\.0\.1:8787/);
    expect(t.text()).toContain("friend daemon stop");
    expect(JSON.parse(readFileSync(t.pidFile(), "utf8")).pid).toBe(4000);
  });

  it("start twice does not start a second one", async () => {
    const t = setup();
    await daemonCommand(["start"], t.io, t.deps);
    expect(await daemonCommand(["start"], t.io, t.deps)).toBe(0);
    expect(t.text()).toMatch(/already running in the background \(pid 4000\)/);
    expect(t.procs.size).toBe(1);
  });

  it("start refuses when the port is taken by something else, and says what to do", async () => {
    const t = setup();
    const deps = { ...t.deps, portOpen: async () => true };
    expect(await daemonCommand(["start"], t.io, deps)).toBe(1);
    expect(t.err.join("\n")).toMatch(/Port 8787 is already in use.*Ctrl\+C/s);
    expect(existsSync(t.pidFile())).toBe(false);
  });

  it("start reports a Friend that dies at once, points at the log and leaves no pid file", async () => {
    const t = setup();
    t.crash();
    expect(await daemonCommand(["start"], t.io, t.deps)).toBe(1);
    expect(t.err.join("\n")).toMatch(/did not start.*friend\.log/);
    expect(existsSync(t.pidFile())).toBe(false);
  });

  it("status says running, with the address, or not running", async () => {
    const t = setup();
    expect(await daemonCommand(["status"], t.io, t.deps)).toBe(1);
    expect(t.text()).toMatch(/not running.*friend daemon start/);
    await daemonCommand(["start"], t.io, t.deps);
    t.out.length = 0;
    expect(await daemonCommand(["status"], t.io, t.deps)).toBe(0);
    expect(t.text()).toMatch(/running in the background \(pid 4000, for 0 seconds\)/);
    expect(t.text()).toContain("Address: http://127.0.0.1:8787");
  });

  it("status ignores a pid file left behind by a crash or a reboot", async () => {
    const t = setup();
    writeFileSync(t.pidFile(), JSON.stringify({ pid: 999, startedAt: 1 }));
    expect(await daemonCommand(["status"], t.io, t.deps)).toBe(1);
    expect(existsSync(t.pidFile())).toBe(false);
  });

  it("status notices Friend running in a terminal instead", async () => {
    const t = setup();
    const deps = { ...t.deps, portOpen: async () => true };
    expect(await daemonCommand(["status"], t.io, deps)).toBe(1);
    expect(t.text()).toMatch(/port 8787 is in use.*terminal/s);
  });

  it("stop ends it and removes the record; stopping again is harmless", async () => {
    const t = setup();
    await daemonCommand(["start"], t.io, t.deps);
    expect(await daemonCommand(["stop"], t.io, t.deps)).toBe(0);
    expect(t.text()).toContain("Friend stopped.");
    expect(t.procs.size).toBe(0);
    expect(existsSync(t.pidFile())).toBe(false);
    expect(await daemonCommand(["stop"], t.io, t.deps)).toBe(0);
    expect(t.text()).toContain("not running in the background");
  });

  it("stop says so when the process will not end", async () => {
    const t = setup();
    await daemonCommand(["start"], t.io, t.deps);
    const stuck = { ...t.deps, kill: async () => {} };
    expect(await daemonCommand(["stop"], t.io, stuck)).toBe(1);
    expect(t.err.join("\n")).toMatch(/Could not stop Friend \(pid 4000\)/);
    expect(existsSync(t.pidFile())).toBe(true);
  });

  it("restart stops the old one and starts a new one", async () => {
    const t = setup();
    await daemonCommand(["start"], t.io, t.deps);
    expect(await daemonCommand(["restart"], t.io, t.deps)).toBe(0);
    expect([...t.procs]).toEqual([4001]);
    expect(JSON.parse(readFileSync(t.pidFile(), "utf8")).pid).toBe(4001);
  });

  it("shows usage for anything else", async () => {
    const t = setup();
    expect(await daemonCommand(["go"], t.io, t.deps)).toBe(1);
    expect(t.err.join("\n")).toMatch(/Usage: friend daemon start \| stop \| restart \| status/);
  });
});
