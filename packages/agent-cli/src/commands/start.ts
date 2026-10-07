import { createApp, loadConfig } from "@friend/server";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IO } from "../cli";
import { startDeviceNode, type DeviceNode } from "../node";

export interface RunningFriend {
  app: Awaited<ReturnType<typeof createApp>>;
  port: number;
  stop(): Promise<void>;
}

export interface StartOptions {
  dataDir: string;
  port?: number;
  webDir?: string;
  out: (line: string) => void;
}

function findWebDir(explicit?: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [explicit, process.env.FRIEND_WEB_DIR, resolve(here, "../../../web/dist"), resolve(here, "web")];
  return candidates.find((c): c is string => !!c && existsSync(join(c, "index.html")));
}

export async function startFriend(opts: StartOptions): Promise<RunningFriend> {
  const stored = loadConfig(opts.dataDir);
  const app = await createApp({
    dataDir: opts.dataDir,
    webDir: findWebDir(opts.webDir),
    config: {
      ...(opts.port !== undefined ? { port: opts.port } : {}),
      apiKey: stored.apiKey ?? process.env.FRIEND_ANTHROPIC_KEY ?? null,
    },
  });
  const { port } = await app.start();

  // The local device token is created once and reused on every start.
  const tokenFile = join(opts.dataDir, "local-device.token");
  let token = existsSync(tokenFile) ? readFileSync(tokenFile, "utf8").trim() : "";
  if (!token || !app.auth.resolveDevice(token)) {
    token = app.auth.redeemPairCode(app.auth.createPairCode(), "this-pc");
    writeFileSync(tokenFile, token, { mode: 0o600 });
  }
  const node: DeviceNode = startDeviceNode({
    url: `ws://127.0.0.1:${port}/device`,
    token,
    roots: app.config.roots,
  });
  opts.out(`Friend is running at http://127.0.0.1:${port}`);
  if (!app.auth.hasOwner()) opts.out("No owner yet. Run: friend setup");
  return {
    app,
    port,
    async stop() {
      node.stop();
      await app.stop();
    },
  };
}

export function waitForSignal(): Promise<void> {
  return new Promise((res) => {
    process.once("SIGINT", res);
    process.once("SIGTERM", res);
  });
}

export async function startCommand(io: IO): Promise<number> {
  const f = await startFriend({ dataDir: io.dataDir, out: io.out });
  await (io.waitForExit ?? waitForSignal)();
  io.out("Stopping…");
  await f.stop();
  return 0;
}
