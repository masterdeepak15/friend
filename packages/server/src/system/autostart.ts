import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, posix, win32 } from "node:path";

/** The program that starts Friend: Node and the Friend program file it runs. */
export interface SelfCommand {
  node: string;
  script: string;
}

export type AutostartKind = "registry" | "launchd" | "systemd" | "xdg" | "none";

export interface AutostartStatus {
  /** This kind of computer can start Friend for the owner. */
  supported: boolean;
  enabled: boolean;
  kind: AutostartKind;
}

export interface AutostartResult {
  ok: boolean;
  message: string;
}

/** What the setup needs from the computer; tests replace it. */
export interface AutostartDeps {
  platform: NodeJS.Platform;
  home: string;
  /** Friend's own folder (the launcher file lives there on Windows, the log on macOS). */
  dataDir: string;
  /** The user's number, for launchctl on macOS. */
  uid: number;
  /** PATH of the program that sets this up, kept so the started Friend can find npm. */
  path: string;
  /** XDG_CONFIG_HOME, when set. */
  configHome?: string;
  exists(p: string): boolean;
  read(p: string): string | null;
  write(p: string, text: string): void;
  remove(p: string): void;
  run(cmd: string, args: string[]): Promise<{ code: number; stdout: string }>;
}

const RUN_KEY = "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run";
const NAME = "Friend";
const LABEL = "com.friend.assistant";
const UNIT = "friend.service";

const quoted = (s: string): string => `"${s}"`;

/** Windows: a tiny script that starts Friend in the background with no window at all. */
export function vbsLauncher(self: SelfCommand): string {
  const cmd = `${quoted(self.node)} ${quoted(self.script)} daemon start`;
  const inVbs = cmd.replace(/"/g, '""');
  return [`' Starts Friend in the background when you sign in. Made by: friend autostart on`, `CreateObject("WScript.Shell").Run "${inVbs}", 0, False`, ""].join("\r\n");
}

const xml = (s: string): string => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** macOS: a launch agent that runs at login. */
export function plistFor(self: SelfCommand, o: { dataDir: string; path: string }): string {
  const log = `${o.dataDir}/friend-autostart.log`;
  return [
    `<?xml version="1.0" encoding="UTF-8"?>`,
    `<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">`,
    `<plist version="1.0">`,
    `<dict>`,
    `  <key>Label</key><string>${LABEL}</string>`,
    `  <key>ProgramArguments</key>`,
    `  <array>`,
    `    <string>${xml(self.node)}</string>`,
    `    <string>${xml(self.script)}</string>`,
    `    <string>daemon</string>`,
    `    <string>start</string>`,
    `  </array>`,
    `  <key>RunAtLoad</key>`,
    `  <true/>`,
    `  <key>EnvironmentVariables</key>`,
    `  <dict><key>PATH</key><string>${xml(o.path)}</string></dict>`,
    `  <key>StandardOutPath</key><string>${xml(log)}</string>`,
    `  <key>StandardErrorPath</key><string>${xml(log)}</string>`,
    `</dict>`,
    `</plist>`,
    "",
  ].join("\n");
}

/** systemd words: quoted, with the quote, the backslash and the percent sign kept from changing what runs. */
const unitWord = (s: string): string => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;

/** Linux: a user service that starts at login (it only starts and stops Friend's background process). */
export function systemdUnit(self: SelfCommand, o: { path: string }): string {
  return [
    "[Unit]",
    "Description=Friend assistant",
    "After=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    `Environment=${unitWord(`PATH=${o.path}`)}`,
    `ExecStart=${unitWord(self.node)} ${unitWord(self.script)} daemon start`,
    `ExecStop=${unitWord(self.node)} ${unitWord(self.script)} daemon stop`,
    "",
    "[Install]",
    "WantedBy=default.target",
    "",
  ].join("\n");
}

/** Desktop file words: quoted, with the characters the format reserves kept from changing what runs. */
const desktopWord = (s: string): string => `"${s.replace(/(["`$\\])/g, "\\$1")}"`;

/** Linux without a user systemd: an entry in the desktop's own autostart folder. */
export function desktopEntry(self: SelfCommand): string {
  return ["[Desktop Entry]", "Type=Application", "Name=Friend", "Comment=Starts Friend in the background", `Exec=${desktopWord(self.node)} ${desktopWord(self.script)} daemon start`, "Terminal=false", "X-GNOME-Autostart-enabled=true", ""].join("\n");
}

/**
 * Starts Friend by itself when the owner signs in to the computer: a hidden launcher in the login list on Windows, a launch
 * agent on macOS, a user service (or an autostart entry) on Linux. Only the signed-in user's own files and entries are touched.
 */
export class Autostart {
  constructor(
    private d: AutostartDeps,
    private self: () => SelfCommand,
  ) {}

  private get win(): boolean {
    return this.d.platform === "win32";
  }
  private get mac(): boolean {
    return this.d.platform === "darwin";
  }
  private get linux(): boolean {
    return this.d.platform === "linux";
  }
  private p() {
    return this.win ? win32 : posix;
  }
  private vbs(): string {
    return win32.join(this.d.dataDir, "autostart.vbs");
  }
  private plist(): string {
    return posix.join(this.d.home, "Library", "LaunchAgents", `${LABEL}.plist`);
  }
  private configDir(): string {
    return this.d.configHome || posix.join(this.d.home, ".config");
  }
  private unitFile(): string {
    return posix.join(this.configDir(), "systemd", "user", UNIT);
  }
  private desktopFile(): string {
    return posix.join(this.configDir(), "autostart", "friend.desktop");
  }
  private async hasSystemd(): Promise<boolean> {
    return (await this.d.run("systemctl", ["--user", "--version"])).code === 0;
  }

  async status(): Promise<AutostartStatus> {
    if (this.win) return { supported: true, enabled: (await this.d.run("reg", ["query", RUN_KEY, "/v", NAME])).code === 0, kind: "registry" };
    if (this.mac) return { supported: true, enabled: this.d.exists(this.plist()), kind: "launchd" };
    if (this.linux) {
      if (await this.hasSystemd()) {
        const r = await this.d.run("systemctl", ["--user", "is-enabled", UNIT]);
        if (r.code === 0 && /enabled/.test(r.stdout)) return { supported: true, enabled: true, kind: "systemd" };
      }
      return { supported: true, enabled: this.d.exists(this.desktopFile()), kind: this.d.exists(this.desktopFile()) ? "xdg" : "none" };
    }
    return { supported: false, enabled: false, kind: "none" };
  }

  async enable(): Promise<AutostartResult> {
    const self = this.self();
    if (!self.node || !self.script) return { ok: false, message: "Friend does not know which program to start. Run it with the friend command and try again." };
    if (this.win) return this.enableWindows(self);
    if (this.mac) return this.enableMac(self);
    if (this.linux) return this.enableLinux(self);
    return { ok: false, message: "Starting Friend by itself is not supported on this kind of computer." };
  }

  async disable(): Promise<AutostartResult> {
    if (this.win) {
      await this.d.run("reg", ["delete", RUN_KEY, "/v", NAME, "/f"]);
      this.d.remove(this.vbs());
    } else if (this.mac) {
      await this.d.run("launchctl", ["bootout", `gui/${this.d.uid}`, this.plist()]);
      this.d.remove(this.plist());
    } else if (this.linux) {
      if (await this.hasSystemd()) {
        await this.d.run("systemctl", ["--user", "disable", UNIT]);
        this.d.remove(this.unitFile());
        await this.d.run("systemctl", ["--user", "daemon-reload"]);
      }
      this.d.remove(this.desktopFile());
    } else return { ok: false, message: "Starting Friend by itself is not supported on this kind of computer." };
    return { ok: true, message: "Friend will no longer start by itself when you sign in." };
  }

  /** Writes the setup again with the program's current place, when it is on. Used after an upgrade. */
  async refresh(): Promise<void> {
    if ((await this.status()).enabled) await this.enable();
  }

  private async enableWindows(self: SelfCommand): Promise<AutostartResult> {
    this.d.write(this.vbs(), vbsLauncher(self));
    const r = await this.d.run("reg", ["add", RUN_KEY, "/v", NAME, "/t", "REG_SZ", "/d", `wscript.exe ${quoted(this.vbs())}`, "/f"]);
    if (r.code !== 0) return { ok: false, message: "Could not add Friend to the programs that start when you sign in." };
    return { ok: true, message: "Friend will start by itself when you sign in to this computer." };
  }

  private async enableMac(self: SelfCommand): Promise<AutostartResult> {
    this.d.write(this.plist(), plistFor(self, { dataDir: this.d.dataDir, path: this.d.path }));
    await this.d.run("launchctl", ["bootout", `gui/${this.d.uid}`, this.plist()]); // a clean start if it was already loaded
    let r = await this.d.run("launchctl", ["bootstrap", `gui/${this.d.uid}`, this.plist()]);
    if (r.code !== 0) r = await this.d.run("launchctl", ["load", "-w", this.plist()]); // older macOS
    if (r.code !== 0) return { ok: false, message: "Could not switch the launch agent on. It will still be used the next time you sign in." };
    return { ok: true, message: "Friend will start by itself when you sign in to this computer." };
  }

  private async enableLinux(self: SelfCommand): Promise<AutostartResult> {
    if (await this.hasSystemd()) {
      this.d.write(this.unitFile(), systemdUnit(self, { path: this.d.path }));
      await this.d.run("systemctl", ["--user", "daemon-reload"]);
      const r = await this.d.run("systemctl", ["--user", "enable", UNIT]);
      if (r.code === 0) {
        this.d.remove(this.desktopFile()); // one way only, so Friend is not started twice
        return { ok: true, message: "Friend will start by itself when you sign in to this computer." };
      }
    }
    this.d.write(this.desktopFile(), desktopEntry(self));
    return { ok: true, message: "Friend will start by itself when you sign in to this computer." };
  }
}

/** The real computer. */
export function realAutostartDeps(dataDir: string): AutostartDeps {
  return {
    platform: process.platform,
    home: homedir(),
    dataDir,
    uid: typeof process.getuid === "function" ? process.getuid() : 0,
    path: process.env.PATH ?? "",
    ...(process.env.XDG_CONFIG_HOME ? { configHome: process.env.XDG_CONFIG_HOME } : {}),
    exists: (p) => existsSync(p),
    read: (p) => {
      try {
        return readFileSync(p, "utf8");
      } catch {
        return null;
      }
    },
    write: (p, text) => {
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, text);
    },
    remove: (p) => rmSync(p, { force: true }),
    run: (cmd, args) =>
      new Promise((resolve) => {
        let out = "";
        const child = spawn(cmd, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
        child.stdout?.on("data", (d: Buffer) => (out += d.toString()));
        child.stderr?.on("data", (d: Buffer) => (out += d.toString()));
        child.on("error", () => resolve({ code: 127, stdout: out }));
        child.on("close", (code) => resolve({ code: code ?? 1, stdout: out }));
      }),
  };
}

/** The program as it is running now: Node, and the Friend program file it was started with. */
export function currentSelf(): SelfCommand {
  const script = process.argv[1] ?? "";
  return { node: process.execPath, script: /\.(mjs|js|cjs)$/i.test(script) ? script : "" };
}
