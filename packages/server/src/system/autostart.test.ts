import { describe, expect, it } from "vitest";
import { Autostart, desktopEntry, plistFor, systemdUnit, vbsLauncher, type AutostartDeps } from "./autostart";

const SELF = { node: "C:\\Program Files\\nodejs\\node.exe", script: "C:\\Users\\me\\AppData\\Roaming\\npm\\node_modules\\friend-assistant\\dist\\friend.mjs" };
const UNIX = { node: "/usr/local/bin/node", script: "/usr/local/lib/node_modules/friend-assistant/dist/friend.mjs" };

function fake(platform: NodeJS.Platform, over: { runs?: (cmd: string, args: string[]) => { code: number; stdout?: string } } = {}) {
  const files = new Map<string, string>();
  const calls: string[][] = [];
  const d: AutostartDeps = {
    platform,
    home: platform === "win32" ? "C:\\Users\\me" : "/home/me",
    dataDir: platform === "win32" ? "C:\\Users\\me\\.friend" : "/home/me/.friend",
    uid: 501,
    path: "/usr/bin:/usr/local/bin",
    exists: (p) => files.has(p),
    read: (p) => files.get(p) ?? null,
    write: (p, t) => void files.set(p, t),
    remove: (p) => void files.delete(p),
    run: async (cmd, args) => {
      calls.push([cmd, ...args]);
      const r = over.runs?.(cmd, args) ?? { code: 0, stdout: "" };
      return { code: r.code, stdout: r.stdout ?? "" };
    },
  };
  return { d, files, calls };
}

describe("what is written for each system", () => {
  it("Windows: a launcher with no window, that starts Friend in the background", () => {
    const v = vbsLauncher(SELF);
    expect(v).toContain("WScript.Shell");
    expect(v).toContain(", 0, False"); // window style 0: hidden, and do not wait
    expect(v).toContain("daemon start");
    expect(v).toContain('""C:\\Program Files\\nodejs\\node.exe""'); // quotes inside a VBScript string are doubled
  });

  it("macOS: a launch agent that runs at login, with the path it was set up with", () => {
    const p = plistFor(UNIX, { dataDir: "/home/me/.friend", path: "/opt/homebrew/bin:/usr/bin" });
    expect(p).toContain("<key>RunAtLoad</key>");
    expect(p).toContain("<true/>");
    expect(p).toContain("<string>/usr/local/bin/node</string>");
    expect(p).toContain("<string>daemon</string>");
    expect(p).toContain("<string>start</string>");
    expect(p).toContain("/opt/homebrew/bin:/usr/bin");
    expect(p).toContain("com.friend.assistant");
  });

  it("macOS: marks that could break the file are escaped", () => {
    const p = plistFor({ node: "/a&b/<node>", script: "/s.mjs" }, { dataDir: "/d", path: "/p" });
    expect(p).toContain("/a&amp;b/&lt;node&gt;");
    expect(p).not.toContain("<node>");
  });

  it("Linux: a user service that starts at login and stops with the session", () => {
    const u = systemdUnit(UNIX, { path: "/usr/bin" });
    expect(u).toContain("[Install]");
    expect(u).toContain("WantedBy=default.target");
    expect(u).toContain('ExecStart="/usr/local/bin/node" "/usr/local/lib/node_modules/friend-assistant/dist/friend.mjs" daemon start');
    expect(u).toContain("ExecStop=");
    expect(u).toContain("daemon stop");
    expect(u).toContain("RemainAfterExit=yes");
    expect(u).toContain('Environment="PATH=/usr/bin"');
  });

  it("Linux: a percent sign or a quote in a path cannot change what runs", () => {
    const u = systemdUnit({ node: '/n"ode', script: "/s%h.mjs" }, { path: "/p" });
    expect(u).toContain('"/n\\"ode"');
    expect(u).toContain("/s%%h.mjs");
  });

  it("Linux without systemd: a desktop entry for the login", () => {
    const e = desktopEntry(UNIX);
    expect(e).toContain("[Desktop Entry]");
    expect(e).toContain("Type=Application");
    expect(e).toContain('Exec="/usr/local/bin/node" "/usr/local/lib/node_modules/friend-assistant/dist/friend.mjs" daemon start');
    expect(e).toContain("X-GNOME-Autostart-enabled=true");
  });
});

describe("Windows", () => {
  it("switches on by writing the launcher and the login entry, and says so", async () => {
    const { d, files, calls } = fake("win32");
    const a = new Autostart(d, () => SELF);
    const r = await a.enable();
    expect(r.ok).toBe(true);
    expect(files.has("C:\\Users\\me\\.friend\\autostart.vbs")).toBe(true);
    const reg = calls.find((c) => c[0] === "reg" && c[1] === "add")!;
    expect(reg).toEqual(expect.arrayContaining(["HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run", "/v", "Friend", "/f"]));
    expect(reg.join(" ")).toMatch(/wscript\.exe .*autostart\.vbs/);
  });

  it("reads whether it is on from the login entry", async () => {
    const on = fake("win32", { runs: () => ({ code: 0, stdout: "    Friend    REG_SZ    wscript.exe x" }) });
    expect(await new Autostart(on.d, () => SELF).status()).toMatchObject({ supported: true, enabled: true, kind: "registry" });
    const off = fake("win32", { runs: () => ({ code: 1 }) });
    expect(await new Autostart(off.d, () => SELF).status()).toMatchObject({ supported: true, enabled: false });
  });

  it("switches off by removing the entry and the launcher", async () => {
    const { d, files, calls } = fake("win32");
    const a = new Autostart(d, () => SELF);
    await a.enable();
    const r = await a.disable();
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c[0] === "reg" && c[1] === "delete" && c.includes("Friend"))).toBe(true);
    expect(files.size).toBe(0);
  });

  it("says plainly when Windows refuses", async () => {
    const { d } = fake("win32", { runs: (_c, args) => (args[0] === "add" ? { code: 1, stdout: "Access is denied." } : { code: 0 }) });
    const r = await new Autostart(d, () => SELF).enable();
    expect(r.ok).toBe(false);
    expect(r.message).toMatch(/could not/i);
  });
});

describe("macOS", () => {
  it("writes the launch agent and loads it", async () => {
    const { d, files, calls } = fake("darwin");
    const r = await new Autostart(d, () => UNIX).enable();
    expect(r.ok).toBe(true);
    const plist = "/home/me/Library/LaunchAgents/com.friend.assistant.plist";
    expect(files.has(plist)).toBe(true);
    expect(calls.some((c) => c[0] === "launchctl" && c[1] === "bootstrap" && c[2] === "gui/501" && c[3] === plist)).toBe(true);
  });

  it("falls back to the older load command when bootstrap is not understood", async () => {
    const { d, calls } = fake("darwin", { runs: (_c, args) => (args[0] === "bootstrap" ? { code: 125 } : { code: 0 }) });
    const r = await new Autostart(d, () => UNIX).enable();
    expect(r.ok).toBe(true);
    expect(calls.some((c) => c[0] === "launchctl" && c[1] === "load" && c.includes("-w"))).toBe(true);
  });

  it("is on when the launch agent is there, and off after removing it", async () => {
    const { d, files, calls } = fake("darwin");
    const a = new Autostart(d, () => UNIX);
    expect((await a.status()).enabled).toBe(false);
    await a.enable();
    expect((await a.status()).enabled).toBe(true);
    await a.disable();
    expect(files.size).toBe(0);
    expect(calls.some((c) => c[0] === "launchctl" && c[1] === "bootout")).toBe(true);
    expect((await a.status()).enabled).toBe(false);
  });
});

describe("Linux", () => {
  it("uses the user's systemd when it is there", async () => {
    const { d, files, calls } = fake("linux");
    const r = await new Autostart(d, () => UNIX).enable();
    expect(r.ok).toBe(true);
    expect(files.has("/home/me/.config/systemd/user/friend.service")).toBe(true);
    expect(calls).toContainEqual(["systemctl", "--user", "enable", "friend.service"]);
    expect(calls).toContainEqual(["systemctl", "--user", "daemon-reload"]);
  });

  it("falls back to an autostart entry when there is no user systemd", async () => {
    const { d, files, calls } = fake("linux", { runs: (cmd, args) => (cmd === "systemctl" && args.includes("--version") ? { code: 127 } : { code: 0 }) });
    const r = await new Autostart(d, () => UNIX).enable();
    expect(r.ok).toBe(true);
    expect(files.has("/home/me/.config/autostart/friend.desktop")).toBe(true);
    expect(calls.some((c) => c.includes("enable"))).toBe(false);
    expect(await new Autostart(d, () => UNIX).status()).toMatchObject({ enabled: true, kind: "xdg" });
  });

  it("follows XDG_CONFIG_HOME when it is set", async () => {
    const { d, files } = fake("linux");
    d.configHome = "/custom/cfg";
    await new Autostart(d, () => UNIX).enable();
    expect(files.has("/custom/cfg/systemd/user/friend.service")).toBe(true);
  });

  it("is on when systemd says the service is enabled", async () => {
    const { d } = fake("linux", { runs: (_cmd, args) => (args.includes("is-enabled") ? { code: 0, stdout: "enabled\n" } : { code: 0 }) });
    expect(await new Autostart(d, () => UNIX).status()).toMatchObject({ enabled: true, kind: "systemd" });
    const off = fake("linux", { runs: (_cmd, args) => (args.includes("is-enabled") ? { code: 1, stdout: "disabled\n" } : { code: 0 }) });
    expect((await new Autostart(off.d, () => UNIX).status()).enabled).toBe(false);
  });

  it("switches off whichever way it was switched on", async () => {
    const { d, files, calls } = fake("linux");
    const a = new Autostart(d, () => UNIX);
    await a.enable();
    await a.disable();
    expect(calls).toContainEqual(["systemctl", "--user", "disable", "friend.service"]);
    expect(files.size).toBe(0);
  });
});

describe("other systems and keeping it right", () => {
  it("says it is not supported on a system it does not know", async () => {
    const { d } = fake("freebsd" as NodeJS.Platform);
    const a = new Autostart(d, () => UNIX);
    expect(await a.status()).toMatchObject({ supported: false, enabled: false });
    expect((await a.enable()).ok).toBe(false);
  });

  it("writes the current paths again when it is already on (after an upgrade moved things)", async () => {
    const { d, files } = fake("linux", { runs: (_cmd, args) => (args.includes("is-enabled") ? { code: 0, stdout: "enabled\n" } : { code: 0 }) });
    let self = UNIX;
    const a = new Autostart(d, () => self);
    await a.enable();
    self = { node: "/opt/node/bin/node", script: "/opt/friend/friend.mjs" };
    await a.refresh();
    expect(files.get("/home/me/.config/systemd/user/friend.service")).toContain("/opt/node/bin/node");
  });

  it("does nothing on refresh when it is off", async () => {
    const { d, files } = fake("linux");
    await new Autostart(d, () => UNIX).refresh();
    expect(files.size).toBe(0);
  });

  it("will not set itself up for a program it cannot name", async () => {
    const { d, files } = fake("linux");
    const r = await new Autostart(d, () => ({ node: "", script: "" })).enable();
    expect(r.ok).toBe(false);
    expect(files.size).toBe(0);
  });
});
