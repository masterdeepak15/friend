import { HttpVoiceService, SidecarProcess, createApp, loadConfig } from "@friend/server";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IO } from "../cli";
import { startDeviceNode, type DeviceNode } from "../node";
import { QUIET_ENV, findVoiceDir, readMarker, voicePaths } from "./voice";

export interface RunningFriend {
  app: Awaited<ReturnType<typeof createApp>>;
  port: number;
  /** True while the local speech engine is running and healthy. */
  voiceAvailable(): boolean;
  stop(): Promise<void>;
}

export interface StartOptions {
  dataDir: string;
  port?: number;
  webDir?: string;
  /** Folder containing the friend_voice Python package. */
  voiceDir?: string;
  out: (line: string) => void;
}

function findWebDir(explicit?: string): string | undefined {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [explicit, process.env.FRIEND_WEB_DIR, resolve(here, "../../../web/dist"), resolve(here, "web")];
  return candidates.find((c): c is string => !!c && existsSync(join(c, "index.html")));
}

export async function startFriend(opts: StartOptions): Promise<RunningFriend> {
  const stored = loadConfig(opts.dataDir);

  // Voice is optional: only when installed (`friend voice setup`) and enabled in the config.
  const marker = stored.voice.enabled ? readMarker(opts.dataDir) : null;
  const secret = randomBytes(24).toString("hex");
  const sidecar = marker
    ? new SidecarProcess({
        command: marker.python,
        args: [
          "-m",
          "friend_voice",
          "--data-dir",
          voicePaths(opts.dataDir).models,
          "--stt-model",
          stored.voice.sttModel,
          "--tts-voice",
          stored.voice.ttsVoice,
        ],
        token: secret,
        cwd: opts.voiceDir ?? findVoiceDir(),
        readyTimeoutMs: 180_000,
        env: QUIET_ENV,
      })
    : null;
  const voice = sidecar ? new HttpVoiceService({ baseUrl: () => sidecar.baseUrl(), token: secret }) : undefined;

  const app = await createApp({
    dataDir: opts.dataDir,
    webDir: findWebDir(opts.webDir),
    voice,
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

  // The speech engine loads its models in the background; clients are told when voice goes up or down.
  const voiceAvailable = () => voice?.available() ?? false;
  let lastAvailable = voiceAvailable();
  let watcher: NodeJS.Timeout | null = null;
  if (sidecar) {
    opts.out("Voice: starting the speech engine…");
    sidecar
      .start()
      .then(() => {
        opts.out("Voice is ready. Hold Space to talk.");
        lastAvailable = voiceAvailable();
        app.notifyStatus();
      })
      .catch((e: Error) => opts.out(`Voice is unavailable: could not start the speech engine (${e.message}). Run: friend voice setup`));
    watcher = setInterval(() => {
      const now = voiceAvailable();
      if (now !== lastAvailable) {
        lastAvailable = now;
        app.notifyStatus();
      }
    }, 3000);
    watcher.unref();
  }

  return {
    app,
    port,
    voiceAvailable,
    async stop() {
      if (watcher) clearInterval(watcher);
      node.stop();
      await sidecar?.stop();
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
