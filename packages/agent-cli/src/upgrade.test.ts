import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IO } from "./cli";
import type { DaemonDeps } from "./commands/daemon";
import { upgradeCommand, type UpgradeDeps } from "./commands/upgrade";

function setup(over: Partial<UpgradeDeps> = {}, opts: { daemonPid?: number; portTaken?: boolean } = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const dataDir = mkdtempSync(join(tmpdir(), "friend-upgrade-"));
  const io: IO = { dataDir, out: (l) => out.push(l), err: (l) => err.push(l), ask: async () => "" };
  const alive = new Set<number>(opts.daemonPid ? [opts.daemonPid] : []);
  if (opts.daemonPid) writeFileSync(join(dataDir, "friend.pid"), JSON.stringify({ pid: opts.daemonPid, startedAt: 1 }));
  const steps: string[] = [];
  const daemon: DaemonDeps = {
    launch: () => 0,
    alive: (pid) => alive.has(pid),
    kill: async (pid) => {
      steps.push("stopped");
      alive.delete(pid);
    },
    portOpen: async () => opts.portTaken === true,
    now: () => 1,
  };
  const deps: UpgradeDeps = {
    current: () => "0.1.5",
    latest: async () => "0.1.6",
    install: async (v) => {
      steps.push(`installed ${v}`);
      return 0;
    },
    startAgain: async () => {
      steps.push("started");
      return 0;
    },
    daemon,
    ...over,
  };
  return { io, out, err, deps, steps, text: () => out.join("\n") };
}

describe("friend upgrade", () => {
  it("stops the background Friend, installs the exact newest version, then starts it again, in that order", async () => {
    const t = setup({}, { daemonPid: 4242 });
    expect(await upgradeCommand([], t.io, t.deps)).toBe(0);
    expect(t.steps).toEqual(["stopped", "installed 0.1.6", "started"]);
    expect(t.text()).toMatch(/Installed: 0\.1\.5[\s\S]*Newest:\s+0\.1\.6[\s\S]*Upgraded 0\.1\.5 → 0\.1\.6/);
  });

  it("when nothing runs in the background it just installs, and says how to start", async () => {
    const t = setup();
    expect(await upgradeCommand([], t.io, t.deps)).toBe(0);
    expect(t.steps).toEqual(["installed 0.1.6"]);
    expect(t.text()).toContain("friend daemon start");
  });

  it("does nothing when already on the newest version, unless forced", async () => {
    const t = setup({ latest: async () => "0.1.5" });
    expect(await upgradeCommand([], t.io, t.deps)).toBe(0);
    expect(t.text()).toContain("already up to date");
    expect(t.steps).toEqual([]);
    expect(await upgradeCommand(["--force"], t.io, t.deps)).toBe(0);
    expect(t.steps).toEqual(["installed 0.1.5"]);
  });

  it("does not downgrade when npm's list is older than what is installed", async () => {
    const t = setup({ current: () => "0.2.0", latest: async () => "0.1.9" });
    expect(await upgradeCommand([], t.io, t.deps)).toBe(0);
    expect(t.steps).toEqual([]);
  });

  it("asks you to press Ctrl+C when Friend is running in a terminal, and installs nothing", async () => {
    const t = setup({}, { portTaken: true });
    expect(await upgradeCommand([], t.io, t.deps)).toBe(1);
    expect(t.err.join("\n")).toMatch(/running in a terminal.*Ctrl\+C/s);
    expect(t.steps).toEqual([]);
  });

  it("says so when npm cannot be reached, and changes nothing", async () => {
    const t = setup({ latest: async () => null }, { daemonPid: 4242 });
    expect(await upgradeCommand([], t.io, t.deps)).toBe(1);
    expect(t.err.join("\n")).toMatch(/Could not ask npm/);
    expect(t.steps).toEqual([]);
  });

  it("if the install fails it explains, and brings the background Friend back instead of leaving it off", async () => {
    const t = setup({ install: async () => 1 }, { daemonPid: 4242 });
    expect(await upgradeCommand([], t.io, t.deps)).toBe(1);
    expect(t.err.join("\n")).toMatch(/install failed.*EBUSY/s);
    expect(t.steps).toEqual(["stopped", "started"]);
  });

  it("shows usage for an unknown option", async () => {
    const t = setup();
    expect(await upgradeCommand(["--wat"], t.io, t.deps)).toBe(1);
    expect(t.err.join("\n")).toMatch(/Usage: friend upgrade \[--force\]/);
  });
});
