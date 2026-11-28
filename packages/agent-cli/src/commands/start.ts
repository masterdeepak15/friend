import { HttpVoiceService, SidecarProcess, createApp, loadConfig } from "@friend/server";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { IO } from "../cli";
import { startDeviceNode, type DeviceNode } from "../node";
import { urlsFor } from "./lan";
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
    system: { checkForUpdates: true }, // looks for a newer Friend after it starts, and updates by itself when that is on
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
    url: `${app.config.https ? "wss" : "ws"}://127.0.0.1:${port}/device`,
    token,
    roots: app.config.roots,
    ...(app.config.https ? { ca: readFileSync(join(opts.dataDir, "tls", "cert.pem"), "utf8") } : {}), // this PC trusts only its own Friend's certificate
  });
  const urls = urlsFor(app.config.bind, port, undefined, app.config.https);
  opts.out(`Friend is running at ${urls.local}`);
  for (const n of urls.network) opts.out(`Also on your network: ${n}`);
  if (!app.auth.hasOwner()) opts.out("No owner yet. Run: friend onboard (guided), or friend setup (just the account)");

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
      // The speech engine and the server stop side by side, and nothing is waited on for long: a program that
      // will not exit must not keep Ctrl+C hanging.
      const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms).unref?.());
      await Promise.race([Promise.allSettled([sidecar?.stop(), app.stop()]), wait(6000)]);
    },
  };
}

export function waitForSignal(): Promise<void> {
  return new Promise((res) => {
    process.once("SIGINT", res);
    process.once("SIGTERM", res);
  });
}

/**
 * Keeps Friend up. A background Friend runs inside this small watcher: when it ends in any way but a stop that was asked for, it is
 * started again after a short wait (longer after each quick failure), and what ended it is in the log.
 */
export async function superviseFriend(io: IO, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Promise<number> {
  let asked = false;
  let child: ReturnType<typeof spawn> | null = null;
  const stop = () => {
    asked = true;
    child?.kill();
  };
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  let quick = 0;
  while (!asked) {
    const began = Date.now();
    const code = await new Promise<number | null>((done) => {
      child = spawn(process.execPath, [process.argv[1]!, "start"], { stdio: "inherit", windowsHide: true, env: { ...process.env, FRIEND_CHILD: "1" } });
      child.on("error", () => done(1));
      child.on("exit", (c) => done(c));
    });
    if (asked || code === 0) return 0;
    quick = Date.now() - began < 60_000 ? quick + 1 : 0;
    const wait = Math.min(30_000, 2000 * 2 ** Math.min(quick, 4));
    io.out(`Friend stopped unexpectedly (code ${code ?? "none"}). Starting it again in ${Math.round(wait / 1000)} seconds.`);
    await sleep(wait);
  }
  return 0;
}

/** One stray error must not end the assistant: it is written to the log and Friend carries on. */
function surviveErrors(io: IO): void {
  const note = (kind: string, e: unknown) => io.out(`${kind}: ${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
  process.on("uncaughtException", (e) => note("An error was caught and ignored", e));
  process.on("unhandledRejection", (e) => note("A failed task was caught and ignored", e));
}

export async function startCommand(io: IO): Promise<number> {
  // in the background: a watcher starts it again if it ever ends by itself
  if (process.env.FRIEND_DAEMON === "1" && process.env.FRIEND_CHILD !== "1" && !io.waitForExit) return superviseFriend(io);
  if (!io.waitForExit) surviveErrors(io);
  const f = await startFriend({ dataDir: io.dataDir, out: io.out });
  await (io.waitForExit ?? waitForSignal)();
  io.out("Stopping…");
  await f.stop();
  return 0;
}
