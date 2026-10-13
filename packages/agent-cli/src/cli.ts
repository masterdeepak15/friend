import { configCommand } from "./commands/config";
import { nodeCommand } from "./commands/node";
import { pairCommand } from "./commands/pair";
import { devicesCommand, rulesCommand } from "./commands/rules";
import { memoryCommand } from "./commands/memory";
import { pluginCommand } from "./commands/plugin";
import { doctorCommand } from "./commands/doctor";
import { lanCommand } from "./commands/lan";
import { autostartCommand } from "./commands/autostart";
import { usageCommand } from "./commands/usage";
import { daemonCommand } from "./commands/daemon";
import { upgradeCommand } from "./commands/upgrade";
import { onboardCommand } from "./commands/onboard";
import { ollamaCommand } from "./commands/ollama";
import { claudeCommand } from "./commands/claude";
import { voiceCommand } from "./commands/voice";
import { setupCommand } from "./commands/setup";
import { secretCommand } from "./commands/secret";
import { startCommand } from "./commands/start";
import { statusCommand } from "./commands/status";

/** Filled in when the program is bundled for npm. */
declare const __FRIEND_VERSION__: string | undefined;

export interface IO {
  dataDir: string;
  out(line: string): void;
  err(line: string): void;
  ask(question: string, opts?: { hidden?: boolean }): Promise<string>;
  /** False when there is no terminal to talk to (input is piped). Unset counts as a terminal. */
  interactive?: boolean;
  /** Resolves when the process should stop (Ctrl+C). Defaults to waiting for a signal. */
  waitForExit?(): Promise<void>;
}

export const USAGE = `Usage: friend <command>

  onboard                    guided setup, step by step: checks this PC, installs what is missing, asks what you want
  doctor                     check what this PC has and what is missing (changes nothing)
  setup                      create the owner account (password, PIN, assistant name)
  password                   change the sign-in password (signs every browser out)
  pin                        change the PIN for risky actions
  start                      run the gateway and a local device node
  daemon start|stop|restart|status  run Friend in the background (no terminal needed), stop it, or see if it is running
  upgrade [--force]          stop the background Friend, install the newest version, start it again
  usage [--days N]|clear     tokens used, day by day (counts only, never words)
  autostart on|off|status    start Friend by itself when you sign in to this computer (Windows, macOS, Linux)
  pair                       print a one-time code to connect another PC
  node --url <ws-url> --code <code> [--roots a,b] [--name pc]
                             connect this PC to a Friend gateway
  ollama setup|status        use a local model through Ollama (no API key needed)
  lan status|on|off|port N|https on|off  let other devices on your network open Friend, change the port, or turn on the secure (https) address a phone needs for the microphone (restart to apply)
  claude setup|status        use your Claude subscription through Claude Code (no API key needed)
  voice setup|list|status|forget  install local speech and choose a female or male voice; check it; forget deletes your saved voice
  memory list|forget <n>|clear  see and delete the notes Friend keeps about you
  plugin catalog|list|install|enable|disable|remove  add skills and sandboxed tools
  rules list|remove <id>     manage always-allow rules
  devices list|revoke <id>   manage paired devices
  status                     show configuration
  config set <key> <value>   change a setting; "friend config keys" lists them all
  version                    print the version

Start here: friend onboard`;

export async function run(argv: string[], io: IO): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "setup":
        return await setupCommand(io);
      case "password":
        return await secretCommand("password", io);
      case "pin":
        return await secretCommand("pin", io);
      case "start":
        return await startCommand(io);
      case "daemon":
        return await daemonCommand(rest, io);
      case "upgrade":
        return await upgradeCommand(rest, io);
      case "usage":
        return await usageCommand(rest, io);
      case "autostart":
        return await autostartCommand(rest, io);
      case "pair":
        return await pairCommand(io);
      case "node":
        return await nodeCommand(rest, io);
      case "voice":
        return await voiceCommand(rest, io);
      case "ollama":
        return await ollamaCommand(rest, io);
      case "onboard":
        return await onboardCommand(rest, io);
      case "doctor":
        return await doctorCommand(io);
      case "help":
      case "--help":
      case "-h":
        io.out(USAGE);
        return 0;
      case "version":
      case "--version":
      case "-v":
        io.out(typeof __FRIEND_VERSION__ === "string" ? __FRIEND_VERSION__ : "development");
        return 0;
      case "lan":
        return await lanCommand(rest, io);
      case "claude":
        return await claudeCommand(rest, io);
      case "memory":
        return await memoryCommand(rest, io);
      case "plugin":
        return await pluginCommand(rest, io);
      case "rules":
        return await rulesCommand(rest, io);
      case "devices":
        return await devicesCommand(rest, io);
      case "status":
        return await statusCommand(io);
      case "config":
        return await configCommand(rest, io);
      default:
        io.err(USAGE);
        return 1;
    }
  } catch (e) {
    io.err(`Error: ${(e as Error).message}`);
    return 1;
  }
}
