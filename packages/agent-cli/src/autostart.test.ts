import { describe, expect, it, vi } from "vitest";
import type { IO } from "./cli";
import type { AutostartStatus } from "@friend/server";
import { autostartCommand } from "./commands/autostart";

function setup(status: AutostartStatus = { supported: true, enabled: false, kind: "systemd" }) {
  const out: string[] = [];
  const err: string[] = [];
  const io: IO = { dataDir: "/d", out: (l) => out.push(l), err: (l) => err.push(l), ask: async () => "" };
  const autostart = {
    status: vi.fn(async () => status),
    enable: vi.fn(async () => ({ ok: true, message: "Friend will start by itself when you sign in to this computer." })),
    disable: vi.fn(async () => ({ ok: true, message: "Friend will no longer start by itself when you sign in." })),
    refresh: vi.fn(async () => {}),
  };
  return { io, out, err, autostart, text: () => out.join("\n") };
}

describe("friend autostart", () => {
  it("switches it on and says what that means", async () => {
    const t = setup();
    expect(await autostartCommand(["on"], t.io, t.autostart)).toBe(0);
    expect(t.autostart.enable).toHaveBeenCalledTimes(1);
    expect(t.text()).toMatch(/start by itself when you sign in/);
  });

  it("switches it off", async () => {
    const t = setup({ supported: true, enabled: true, kind: "systemd" });
    expect(await autostartCommand(["off"], t.io, t.autostart)).toBe(0);
    expect(t.autostart.disable).toHaveBeenCalledTimes(1);
    expect(t.text()).toMatch(/no longer start by itself/);
  });

  it("says whether it is on", async () => {
    const on = setup({ supported: true, enabled: true, kind: "registry" });
    expect(await autostartCommand(["status"], on.io, on.autostart)).toBe(0);
    expect(on.text()).toMatch(/starts by itself.*yes/i);
    const off = setup();
    await autostartCommand(["status"], off.io, off.autostart);
    expect(off.text()).toMatch(/starts by itself.*no/i);
    expect(off.text()).toMatch(/friend autostart on/);
  });

  it("says so on a computer it cannot set up", async () => {
    const t = setup({ supported: false, enabled: false, kind: "none" });
    await autostartCommand(["status"], t.io, t.autostart);
    expect(t.text()).toMatch(/not supported/i);
  });

  it("fails with the reason when switching on did not work", async () => {
    const t = setup();
    t.autostart.enable.mockResolvedValueOnce({ ok: false, message: "Could not add Friend to the programs that start when you sign in." });
    expect(await autostartCommand(["on"], t.io, t.autostart)).toBe(1);
    expect(t.err.join("\n")).toMatch(/Could not add Friend/);
  });

  it("refresh writes the setup again quietly, only used after an upgrade", async () => {
    const t = setup();
    expect(await autostartCommand(["refresh"], t.io, t.autostart)).toBe(0);
    expect(t.autostart.refresh).toHaveBeenCalledTimes(1);
    expect(t.out).toEqual([]);
  });

  it("shows usage for anything else", async () => {
    const t = setup();
    expect(await autostartCommand([], t.io, t.autostart)).toBe(1);
    expect(await autostartCommand(["maybe"], t.io, t.autostart)).toBe(1);
    expect(t.err.join("\n")).toMatch(/Usage: friend autostart on\|off\|status/);
  });
});
