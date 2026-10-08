import { configCommand } from "./commands/config";
import { nodeCommand } from "./commands/node";
import { pairCommand } from "./commands/pair";
import { devicesCommand, rulesCommand } from "./commands/rules";
import { memoryCommand } from "./commands/memory";
import { pluginCommand } from "./commands/plugin";
import { ollamaCommand } from "./commands/ollama";
import { voiceCommand } from "./commands/voice";
import { setupCommand } from "./commands/setup";
import { startCommand } from "./commands/start";
import { statusCommand } from "./commands/status";

export interface IO {
  dataDir: string;
  out(line: string): void;
  err(line: string): void;
  ask(question: string, opts?: { hidden?: boolean }): Promise<string>;
  /** Resolves when the process should stop (Ctrl+C). Defaults to waiting for a signal. */
  waitForExit?(): Promise<void>;
}

export const USAGE = `Usage: friend <command>

  setup                      create the owner account (password, PIN, assistant name)
  start                      run the gateway and a local device node
  pair                       print a one-time code to connect another PC
  node --url <ws-url> --code <code> [--roots a,b] [--name pc]
                             connect this PC to a Friend gateway
  ollama setup|status        use a local model through Ollama (no API key needed)
  voice setup|status|forget  install or check local speech (hold Space to talk); forget deletes your saved voice
  memory list|forget <n>|clear  see and delete the notes Friend keeps about you
  plugin catalog|list|install|enable|disable|remove  add skills and sandboxed tools
  rules list|remove <id>     manage always-allow rules
  devices list|revoke <id>   manage paired devices
  status                     show configuration
  config set <key> <value>   keys: apiKey, model, port, bind, publicUrl, roots, trustProxy, allowedOrigins`;

export async function run(argv: string[], io: IO): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "setup":
        return await setupCommand(io);
      case "start":
        return await startCommand(io);
      case "pair":
        return await pairCommand(io);
      case "node":
        return await nodeCommand(rest, io);
      case "voice":
        return await voiceCommand(rest, io);
      case "ollama":
        return await ollamaCommand(rest, io);
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
