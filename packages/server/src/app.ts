import type { ClientMsg, ServerMsg } from "@friend/protocol";
import { Agent, type AgentSettings } from "./agent/loop";
import { isCatalogVoice, voiceLabel } from "@friend/protocol";
import { makeAdmin } from "./admin";
import { firstExistingDir } from "./assets";
import { chatLines } from "./chatlog";
import { McpHub } from "./connectors/hub";
import { PRESETS } from "./connectors/presets";
import { isQuickPreset, quickCheck, quickConnect, quickInstall, type QuickRunner } from "./connectors/quick";
import { runCommand } from "./connectors/run";
import { ConnectorStore } from "./connectors/store";
import { Approvals } from "./approvals";
import { Audit } from "./audit";
import { Auth, LockoutError } from "./auth";
import { CameraBroker } from "./camera";
import { CodeBox } from "./codebox";
import { Heartbeat } from "./heartbeat";
import { Memory } from "./memory";
import { Plugins, isPluginId, listCatalog } from "./plugins";
import { WeatherService } from "./weather";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Tasks } from "./tasks";
import { join } from "node:path";
import { loadConfig, saveConfig, type Config } from "./config";
import { openDb } from "./db";
import { DeviceHub } from "./devices";
import { createGateway, type ClientConn, type ConnectorsApi, type PluginsApi } from "./gateway";
import { PolicyEngine } from "./policy/engine";
import { ClaudeProvider } from "./provider/claude";
import { ClaudeCodeProvider } from "./provider/claude-code/provider";
import { FallbackProvider } from "./provider/fallback";
import { SwitchableProvider } from "./provider/switchable";
import { applySettings, clientLook, COSMETIC_KEYS, refuseForAgent, settingsView, SettingsError, type Applied } from "./settings";
import { OllamaProvider } from "./provider/ollama";
import type { Provider, ProviderEvent, StreamRequest } from "./provider/types";
import { StageState } from "./stage";
import { HttpError } from "./http-error";
import { Challenges } from "./voice/challenge";
import { loadOrCreateKey } from "./voice/crypto";
import { EnrollError, Enrollment } from "./voice/enrollment";
import { VoiceError, type VoiceService } from "./voice/service";
import { Speaker } from "./voice/speaker";
import { Voiceprint, decideTrust, type VoiceTrust } from "./voice/voiceprint";

/** Recorded with each voiceprint so a model change can be told apart later. */
const SPEAKER_MODEL = "wespeaker_en_voxceleb_resnet34";

export interface AppOptions {
  dataDir: string;
  provider?: Provider;
  /** Speech in and out; without it voice is simply unavailable. */
  voice?: VoiceService;
  config?: Partial<Config>;
  webDir?: string;
  expireIntervalMs?: number;
  approvalTimeoutMs?: number;
  /** How long a camera request waits for the browser's picture. */
  cameraTimeoutMs?: number;
  /** How often the heartbeat looks for reminders that have come due. */
  heartbeatMs?: number;
  /** Where the agent's programs run. Defaults to throwaway Docker containers. */
  codeBox?: Pick<CodeBox, "run">;
  /** Folder with the bundled plugins (one folder per plugin). Defaults to `plugins/` in the repository. */
  pluginCatalogDir?: string;
  /** The one-click connectors: how their install command is run and where the person's home folder is (tests). */
  quick?: { run?: QuickRunner; home?: string };
  /** Where weather comes from. Defaults to Open-Meteo. */
  weather?: Pick<WeatherService, "get">;
}

/** Used when no API key is configured: every turn ends with a setup notice on screen. */
class MissingKeyProvider implements Provider {
  id = "missing-key";
  async *stream(_req: StreamRequest): AsyncIterable<ProviderEvent> {
    yield {
      type: "error",
      userFacing: true,
      message:
        "I need an Anthropic API key before I can think. Run: friend config set apiKey <your key>. Or use a local model: friend ollama setup --use",
    };
  }
}

export async function createApp(opts: AppOptions) {
  const config = { ...loadConfig(opts.dataDir), ...opts.config };
  const db = openDb(opts.dataDir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  const policy = new PolicyEngine(db, config);
  const devices = new DeviceHub();
  const stage = new StageState();
  stage.setLook(config.look); // the owner's own style, colour and brightness are where every screen starts
  const approvals = new Approvals({ auth, policy, audit, db }, opts.approvalTimeoutMs);
  // told to the screen once the clients exist (below); Claude Code is skipped quietly until then
  let tellFallback: (reason: string) => void = () => {};
  /** Builds the model backend from the current settings; called again when the owner changes them on screen. */
  const makeProvider = (): Provider => {
    if (config.provider === "claude-code") {
      const cc = new ClaudeCodeProvider({ dataDir: opts.dataDir, model: config.claudeCode.model, command: config.claudeCode.command });
      return config.claudeCode.fallback === "ollama" ? new FallbackProvider(cc, new OllamaProvider({ ...config.ollama }), (reason) => tellFallback(reason)) : cc;
    }
    if (config.provider === "ollama") return new OllamaProvider({ ...config.ollama });
    return config.apiKey ? new ClaudeProvider({ apiKey: config.apiKey, model: config.model }) : new MissingKeyProvider();
  };
  const switchable = opts.provider ? null : new SwitchableProvider(makeProvider());
  const provider: Provider = opts.provider ?? switchable!;
  const camera = new CameraBroker(opts.cameraTimeoutMs);
  const memory = new Memory(db);
  const tasks = new Tasks(db);
  const plugins = new Plugins(db, join(opts.dataDir, "plugins"));
  const hub = new McpHub(new ConnectorStore(opts.dataDir));
  const admin = makeAdmin({ hub, plugins, dataDir: opts.dataDir, audit: (what, detail) => audit.log("agent", what, detail) });
  /** Validates, applies and saves a settings change, then tells the screens. Used by the settings screen and by the AI. */
  function commitSettings(patch: unknown, how: { actor: "owner" | "agent"; ip?: string; deferSwap?: boolean }): Applied {
    let applied: Applied;
    let voiceBefore = config.voice.ttsVoice;
    try {
      // the same change on a fresh copy of what is saved, so only the owner's own edits reach the file
      const saved = loadConfig(opts.dataDir);
      const check = applySettings(saved, patch);
      if (!how.deferSwap && switchable && check.providerChanged && agent.isBusy()) {
        throw new HttpError(409, "Friend is busy with a request. Change the model when it is done.");
      }
      voiceBefore = config.voice.ttsVoice;
      applied = applySettings(config, patch);
      saveConfig(saved);
    } catch (e) {
      if (e instanceof SettingsError) throw new HttpError(400, e.message);
      throw e;
    }
    audit.log(how.actor, "settings.changed", { changed: applied.changed, ...(how.ip ? { ip: how.ip } : {}) });
    if (applied.providerChanged && switchable) {
      const swap = () => {
        const old = switchable.swap(makeProvider());
        void old.close?.().catch(() => {});
      };
      // the AI is answering through the current backend right now, so its own change waits until the reply is done
      if (how.deferSwap) agent.whenIdle(swap);
      else swap();
    }
    if (applied.changed.includes("voice.ttsVoice")) void warmVoice(config.voice.ttsVoice, voiceBefore);
    if (applied.changed.some((k) => k === "view" || k.startsWith("look."))) {
      if (applied.changed.some((k) => k.startsWith("look."))) for (const command of stage.setLook(config.look)) broadcast({ type: "stage", command });
      broadcast(uiMsg());
    }
    broadcast(statusMsg());
    return applied;
  }
  /**
   * A new speaking voice is loaded (and downloaded the first time, about 60 MB) in the background, so the first sentence in it
   * does not have to wait. If it cannot be loaded the previous voice is put back, so Friend is never left silent.
   */
  async function warmVoice(wanted: string, previous: string): Promise<void> {
    if (!voice || !voiceAvailable()) return; // the speech engine is not running: it loads the voice when it starts
    broadcast({ type: "alert", level: "info", text: `Loading the voice ${voiceLabel(wanted)}. The first time it downloads about 60 MB.` });
    try {
      await voice.synthesize("Ready.", wanted);
      broadcast({ type: "alert", level: "info", text: `The voice ${voiceLabel(wanted)} is ready.` });
    } catch (e) {
      audit.log("system", "voice.load_failed", { voice: wanted, message: (e as Error).message });
      if (config.voice.ttsVoice === wanted) {
        config.voice.ttsVoice = previous;
        const saved = loadConfig(opts.dataDir);
        saved.voice.ttsVoice = previous;
        saveConfig(saved);
      }
      broadcast({ type: "alert", level: "warn", text: `Could not load the voice ${wanted} (it needs internet the first time). Using ${voiceLabel(previous)} again.` });
    }
  }

  const agentSettings: AgentSettings = {
    get: () => settingsView(config),
    setView: (view) => {
      commitSettings({ view }, { actor: "agent" });
      return `The view is now ${view}.`;
    },
    setLook: (look) => {
      commitSettings({ look }, { actor: "agent" });
      return "The look is updated and saved.";
    },
    set: async (patch) => {
      refuseForAgent(patch);
      const applied = commitSettings(patch, { actor: "agent", deferSwap: true });
      return applied.providerChanged ? "Saved. The new model is used from the next reply." : "Saved.";
    },
  };

  const agent = new Agent({
    settings: agentSettings,
    mcp: hub,
    admin,
    provider,
    policy,
    approvals,
    devices,
    stage,
    db,
    audit,
    config,
    assistantName: () => auth.assistantName(),
    memory,
    tasks,
    plugins,
    weather: opts.weather ?? new WeatherService(),
    code: opts.codeBox ?? new CodeBox(),
    camera: {
      request: (emit, signal) => {
        audit.log("agent", "camera.requested", {});
        return camera.request(emit, signal);
      },
    },
  });

  const clients = new Set<ClientConn>();
  const broadcast = (m: ServerMsg) => {
    for (const c of clients) c.send(m);
  };
  tellFallback = (reason) => {
    audit.log("system", "provider.fallback", { reason: reason.slice(0, 300) });
    broadcast({ type: "alert", level: "info", text: `${reason} Using the local model for now.` });
  };
  const voice = opts.voice;
  const speaker = voice ? new Speaker(voice, audit, () => config.voice.ttsVoice) : null;
  const voiceAvailable = () => !!voice && voice.available();
  // The owner's voiceprint: encrypted at rest, key in a private file next to the database.
  const voiceprint = voice ? new Voiceprint(db, loadOrCreateKey(join(opts.dataDir, "voice.key"))) : null;
  const enrollment = voiceprint ? new Enrollment(voiceprint, SPEAKER_MODEL) : null;
  const challenges = new Challenges((id) => {
    broadcast({ type: "voice.challenge.end", id });
    broadcast({ type: "alert", level: "info", text: "The voice request timed out and was dropped." });
  });
  let stopped = false;
  const uiMsg = (): ServerMsg => ({ type: "ui", view: config.view, look: clientLook(config.look) });
  const statusMsg = (): ServerMsg => ({
    type: "status",
    busy: agent.isBusy(),
    deviceOnline: devices.hasOnline(),
    voiceAvailable: voiceAvailable(),
    // sockets can still close while the app shuts down, after the database is gone
    voiceEnrolled: !stopped && (voiceprint?.exists() ?? false),
  });
  devices.onChange(() => broadcast(statusMsg()));

  /** Bumped by the emergency lock: anything that started before it must not start or speak after it. */
  let lockEpoch = 0;

  // The heartbeat only notifies: an alert, a card on the screen and a spoken line. It never starts a turn or runs a tool.
  const heartbeat = new Heartbeat({
    tasks,
    clients: () => clients.size,
    busy: () => agent.isBusy(),
    intervalMs: opts.heartbeatMs,
    notify: (task) => {
      const object = {
        id: `reminder-${task.id}`,
        type: "card" as const,
        props: { title: "Reminder", text: task.title },
        placement: "center" as const,
        ttl: 90,
        style: "alert" as const,
      };
      const show = { cmd: "show" as const, object };
      stage.apply(show);
      broadcast({ type: "stage", command: show });
      broadcast({ type: "alert", level: "info", text: `Reminder: ${task.title}` });
      audit.log("system", "task.fired", { id: task.id });
      if (speaker) void speaker.speak(`Reminder: ${task.title}`, broadcast).catch(() => {});
    },
  });

  /** Checks the owner's PIN through the shared rate limit. */
  async function requirePin(pin: string, ip: string): Promise<void> {
    let ok = false;
    try {
      ok = await auth.verifyPin(pin, ip);
    } catch (e) {
      if (e instanceof LockoutError) throw new HttpError(429, e.message);
      throw e;
    }
    if (!ok) throw new HttpError(403, "Incorrect PIN");
  }

  /** How much to trust a voice. A recording too short to identify cannot be trusted, but only the PIN can settle it. */
  function judge(embedding: number[] | null): VoiceTrust {
    if (!embedding) return "challenge";
    let score: number | null;
    try {
      score = voiceprint!.score(embedding);
    } catch (e) {
      audit.log("system", "voice.score_failed", { message: (e as Error).message });
      return "guest";
    }
    if (score === null) return "guest";
    const trust = decideTrust(score, config.voice);
    audit.log("system", "voice.trust", { trust, score: Math.round(score * 1000) / 1000 });
    return trust;
  }

  /** Runs the turn for something that was said, then speaks the reply. Guests get the isolated guest turn. */
  async function runVoiceTurn(text: string, ip: string, epoch: number, trust: "owner" | "guest" = "owner"): Promise<void> {
    // the voice keeps pace with the captions: each sentence is spoken as soon as it has been written
    const talk = speaker?.stream(broadcast);
    const emit = (m: ServerMsg) => {
      if (m.type === "caption.delta" && epoch === lockEpoch) talk?.push(m.text); // locked meanwhile: stay silent
      broadcast(m);
    };
    await agent.runTurn(text, { trust, emit, ip });
    await talk?.end();
  }

  /** The owner answers "was that you?" with the PIN; only then do the held-back words run, as the owner. */
  async function confirmChallenge(id: string, pin: string, conn: ClientConn): Promise<void> {
    if (!challenges.get(id)) {
      conn.send({ type: "alert", level: "info", text: "That voice request already expired." });
      return;
    }
    if (agent.isBusy()) {
      conn.send({ type: "alert", level: "warn", text: "Friend is busy with the last request. Confirm again in a moment." });
      return;
    }
    const epoch = lockEpoch;
    try {
      await requirePin(pin, conn.ip);
    } catch (e) {
      if (!(e instanceof HttpError)) throw e;
      if (e.status === 403 && challenges.wrongPin(id)) {
        audit.log("owner", "voice.challenge_failed", { ip: conn.ip });
        broadcast({ type: "voice.challenge.end", id });
        conn.send({ type: "alert", level: "error", text: "Too many wrong PINs. The voice request was dropped." });
      } else {
        conn.send({ type: "alert", level: e.status === 429 ? "error" : "warn", text: e.status === 403 ? "Incorrect PIN" : e.message });
      }
      return;
    }
    if (epoch !== lockEpoch) return; // locked while the PIN was being checked
    const held = challenges.take(id);
    if (!held) return; // answered, cancelled or expired meanwhile
    audit.log("owner", "voice.challenge_confirmed", { ip: conn.ip });
    broadcast({ type: "voice.challenge.end", id });
    broadcast({ type: "voice.heard", text: held.text, trust: "owner" });
    await runVoiceTurn(held.text, conn.ip, epoch);
  }

  const here = dirname(fileURLToPath(import.meta.url));
  // next to the program when installed from npm, in the repository when run from source
  const catalogDir = opts.pluginCatalogDir ?? firstExistingDir([process.env.FRIEND_PLUGIN_CATALOG, resolve(here, "plugins"), resolve(here, "../../..", "plugins")]) ?? resolve(here, "plugins");
  const pluginsApi: PluginsApi = {
    list: () => {
      const installed = plugins.list();
      const have = new Set(installed.map((p) => p.id));
      return { installed, catalog: listCatalog(catalogDir).map((c) => ({ ...c, installed: have.has(c.id) })) };
    },
    install: async (id, pin, ip) => {
      if (!isPluginId(id)) throw new HttpError(400, "That is not a plugin name.");
      if (!listCatalog(catalogDir).some((c) => c.id === id)) throw new HttpError(404, "That plugin is not in the catalog.");
      await requirePin(pin, ip);
      const r = plugins.install(join(catalogDir, id));
      if (!r.ok) throw new HttpError(400, `That plugin cannot be installed: ${r.error}`);
      audit.log("owner", "plugin.installed", { id: r.id, upgraded: r.upgraded, ip });
      return { id: r.id, upgraded: r.upgraded };
    },
    setEnabled: async (id, enabled, pin, ip) => {
      if (!isPluginId(id) || !plugins.list().some((p) => p.id === id)) throw new HttpError(404, "There is no such plugin.");
      if (enabled) {
        if (!pin) throw new HttpError(400, "Enter your PIN to switch a plugin on.");
        await requirePin(pin, ip);
      }
      plugins.setEnabled(id, enabled);
      audit.log("owner", enabled ? "plugin.enabled" : "plugin.disabled", { id, ip });
    },
    reload: () => {
      plugins.reload();
      audit.log("owner", "plugin.reloaded", {});
    },
    remove: (id) => {
      if (!isPluginId(id) || !plugins.remove(id)) throw new HttpError(404, "There is no such plugin.");
      audit.log("owner", "plugin.removed", { id });
    },
  };

  const connectorsApi: ConnectorsApi = {
    list: () => ({ connectors: hub.list(), presets: PRESETS }),
    add: async (input, pin, ip) => {
      await requirePin(pin, ip);
      try {
        const v = await hub.add(input);
        audit.log("owner", "connector.added", { id: v.id, kind: v.kind, status: v.status, ip });
        return v;
      } catch (e) {
        throw new HttpError(400, (e as Error).message);
      }
    },
    setEnabled: async (id, enabled, pin, ip) => {
      if (enabled) {
        if (!pin) throw new HttpError(400, "Enter your PIN to switch a connector on.");
        await requirePin(pin, ip);
      }
      try {
        const v = await hub.setEnabled(id, enabled);
        audit.log("owner", enabled ? "connector.enabled" : "connector.disabled", { id, ip });
        return v;
      } catch (e) {
        throw new HttpError(404, (e as Error).message);
      }
    },
    reload: async (id) => {
      try {
        return await hub.reload(id);
      } catch (e) {
        throw new HttpError(404, (e as Error).message);
      }
    },
    quickCheck: (preset) => {
      const c = quickCheck(preset, { home: opts.quick?.home });
      if (!c) throw new HttpError(404, "That is not a one-click connector.");
      return c;
    },
    quickInstall: async (preset, pin, ip) => {
      if (!isQuickPreset(preset)) throw new HttpError(404, "That is not a one-click connector.");
      await requirePin(pin, ip);
      audit.log("owner", "connector.quick_install", { preset, ip });
      return quickInstall(preset, { hub, run: opts.quick?.run ?? runCommand, home: opts.quick?.home });
    },
    quickConnect: async (preset, pin, ip) => {
      if (!isQuickPreset(preset)) throw new HttpError(404, "That is not a one-click connector.");
      await requirePin(pin, ip);
      const result = await quickConnect(preset, { hub, run: opts.quick?.run ?? runCommand, home: opts.quick?.home });
      audit.log("owner", "connector.quick_connect", { preset, ok: result.ok, extension: result.extension, ip });
      return result;
    },
    remove: async (id) => {
      try {
        await hub.remove(id);
        audit.log("owner", "connector.removed", { id });
      } catch (e) {
        throw new HttpError(404, (e as Error).message);
      }
    },
  };

  const gateway = createGateway({
    connectors: connectorsApi,
    voicePreview: async (id) => {
      if (!voice || !voiceAvailable()) throw new HttpError(503, "Voice is not available. Run: friend voice setup");
      if (!isCatalogVoice(id) && id !== config.voice.ttsVoice) throw new HttpError(400, "That voice is not in the list.");
      return voice.synthesize(`Hello, I am ${auth.assistantName()}. This is how I sound.`, id);
    },
    config,
    auth,
    audit,
    webDir: opts.webDir,
    voiceAvailable,
    onVoiceUtterance: async (session, audio, mime, ip) => {
      if (!voice) throw new HttpError(503, "Voice is not available");
      if (agent.isBusy()) throw new HttpError(409, "Friend is busy with the last request. Try again in a moment.");
      const epoch = lockEpoch;
      const enrolled = voiceprint?.exists() ?? false;
      let heard: string;
      let embedding: number[] | null = null;
      try {
        const t = await voice.transcribe(audio, mime, config.voice.language, { embed: enrolled });
        heard = t.text.trim();
        embedding = t.embedding ?? null;
      } catch (e) {
        // our own voice errors carry no internal detail and can be shown; anything else stays in the audit log
        if (e instanceof VoiceError) throw new HttpError(502, e.message);
        throw e;
      }
      // the session may have been locked or logged out while the recording was being transcribed
      if (epoch !== lockEpoch || !auth.sessionActive(session.id)) throw new HttpError(401, "Session ended");
      // nothing intelligible (silence, noise, punctuation only): no turn, nothing shown
      if (!/[\p{L}\p{N}]/u.test(heard)) return { text: "" };
      const crash = (e: unknown) => audit.log("system", "voice.turn_crash", { message: (e as Error).message });
      const trust = enrolled ? judge(embedding) : "unverified";
      if (trust === "challenge") {
        // close, but not sure enough: nothing runs unless the owner confirms with the PIN
        const { challenge, replaced } = challenges.open(heard, ip);
        if (replaced) broadcast({ type: "voice.challenge.end", id: replaced });
        broadcast({ type: "voice.challenge", id: challenge.id, text: heard });
      } else if (trust === "guest") {
        broadcast({ type: "voice.heard", text: heard, trust: "guest" });
        broadcast({ type: "alert", level: "warn", text: `An unrecognized voice said: "${heard.slice(0, 200)}"` });
        audit.log("system", "voice.guest", { text: heard.slice(0, 200) });
        void runVoiceTurn(heard, ip, epoch, "guest").catch(crash);
      } else {
        broadcast({ type: "voice.heard", text: heard, trust: trust === "owner" ? "owner" : "unverified" });
        void runVoiceTurn(heard, ip, epoch).catch(crash);
      }
      return { text: heard };
    },
    voiceEnroll: enrollment && voice
      ? {
          state: () => enrollment.state(),
          sample: async (audio, mime) => {
            let embedding: number[];
            try {
              embedding = (await voice.embed(audio, mime)).embedding;
            } catch (e) {
              if (e instanceof VoiceError) throw new HttpError(400, e.message);
              throw e;
            }
            try {
              return enrollment.add(embedding);
            } catch (e) {
              if (e instanceof EnrollError) throw new HttpError(400, e.message);
              throw e;
            }
          },
          finish: async (pin, ip) => {
            await requirePin(pin, ip);
            try {
              const out = enrollment.finish();
              audit.log("owner", "voice.enrolled", { samples: out.samples, ip });
              broadcast(statusMsg());
              return out;
            } catch (e) {
              if (e instanceof EnrollError) throw new HttpError(400, e.message);
              throw e;
            }
          },
          cancel: () => enrollment.cancel(),
          remove: async (pin, ip) => {
            await requirePin(pin, ip);
            enrollment.remove();
            audit.log("owner", "voice.removed", { ip });
            broadcast(statusMsg());
          },
        }
      : undefined,
    plugins: pluginsApi,
    settings: {
      get: () => settingsView(config),
      update: async (patch, pin, ip) => {
        // how the screen looks needs no PIN: it changes what is shown and nothing else
        const looksOnly = !!patch && typeof patch === "object" && Object.keys(patch).length > 0 && Object.keys(patch).every((k) => COSMETIC_KEYS.has(k));
        if (!looksOnly) {
          if (!pin) throw new HttpError(400, "Enter your PIN to save settings");
          await requirePin(pin, ip);
        }
        const before = JSON.stringify(settingsView(config));
        const applied = commitSettings(patch, { actor: "owner", ip });
        return { settings: settingsView(config), changed: JSON.stringify(settingsView(config)) !== before, restart: applied.restart };
      },
    },
    data: {
      history: () => chatLines(db),
      tasks: () => tasks.list(),
    },
    onCameraFrame: (id, jpeg) => {
      const out = camera.deliver(id, jpeg);
      if (out === "ok") {
        audit.log("owner", "camera.frame", { bytes: jpeg.length }); // size only, never pixels
        broadcast({ type: "camera.cancel", id }); // every other tab stops waiting
      } else {
        audit.log("owner", "camera.frame_ignored", { reason: out, bytes: jpeg.length });
      }
      return out;
    },
    onClientConnect: (_session, conn) => {
      clients.add(conn);
      conn.send({ type: "snapshot", stage: stage.snapshot(), pendingApproval: approvals.pending() });
      conn.send(statusMsg());
      conn.send(uiMsg());
      const pending = challenges.current();
      if (pending) conn.send({ type: "voice.challenge", id: pending.id, text: pending.text });
      return () => clients.delete(conn);
    },
    onClientMessage: (_session, msg: ClientMsg, conn) => {
      switch (msg.type) {
        case "chat.send":
          // the reply is spoken as it is written, like one to a spoken request, unless the owner turned that off
          if (speaker && voiceAvailable() && config.voice.speakTyped) {
            void runVoiceTurn(msg.text, conn.ip, lockEpoch).catch((e) => audit.log("system", "turn.crash", { message: (e as Error).message }));
          } else {
            void agent
              .runTurn(msg.text, { trust: "owner", emit: broadcast, ip: conn.ip })
              .catch((e) => audit.log("system", "turn.crash", { message: (e as Error).message }));
          }
          break;
        case "approval.respond":
          void approvals
            .respond(msg, conn.ip)
            .catch((e) => audit.log("system", "approval.error", { message: (e as Error).message }));
          break;
        case "voice.interrupt":
          speaker?.interrupt(broadcast);
          break;
        case "voice.confirm":
          void confirmChallenge(msg.id, msg.pin, conn).catch((e) => audit.log("system", "voice.confirm_error", { message: (e as Error).message }));
          break;
        case "camera.denied":
          if (camera.deny(msg.id, msg.reason)) {
            audit.log("owner", "camera.denied", { reason: msg.reason });
            broadcast({ type: "camera.cancel", id: msg.id });
          }
          break;
        case "voice.cancel":
          if (challenges.take(msg.id)) {
            audit.log("owner", "voice.challenge_cancelled", { ip: conn.ip });
            broadcast({ type: "voice.challenge.end", id: msg.id });
          }
          break;
        case "ui.panels":
          stage.setPanels(msg.open);
          break;
        case "ping":
          conn.send(statusMsg());
          break;
        case "stage.event":
          audit.log("owner", "stage.event", { objectId: msg.objectId, event: msg.event });
          if (msg.event === "dismiss" && stage.apply({ cmd: "hide", id: msg.objectId }).ok) {
            broadcast({ type: "stage", command: { cmd: "hide", id: msg.objectId } });
          }
          break;
      }
    },
    onDeviceConnect: (device, ws) => devices.attach(device, ws),
    onLock: () => {
      lockEpoch++;
      const dropped = challenges.clear();
      if (dropped) broadcast({ type: "voice.challenge.end", id: dropped });
      enrollment?.cancel();
      camera.cancelAll(broadcast);
      agent.cancel();
      speaker?.interrupt(broadcast);
      approvals.denyAll("Emergency lock");
      for (const c of [...clients]) c.close(4401, "locked");
    },
  });

  let timer: NodeJS.Timeout | null = null;

  return {
    config,
    db,
    audit,
    auth,
    policy,
    approvals,
    devices,
    stage,
    agent,
    /** The model backend in use right now (it can change when the owner edits settings). */
    provider,
    gateway,
    voiceprint,
    challenges,
    camera,
    memory,
    tasks,
    plugins,
    /** Tell every client the voice sidecar went up or down. */
    notifyStatus(): void {
      broadcast(statusMsg());
    },
    async start(): Promise<{ port: number }> {
      heartbeat.start();
      hub.startAll(); // connectors that were on come back in the background; Friend does not wait for them
      timer = setInterval(() => {
        for (const id of stage.expire()) broadcast({ type: "stage", command: { cmd: "hide", id } });
      }, opts.expireIntervalMs ?? 1000);
      return gateway.listen();
    },
    async stop(): Promise<void> {
      stopped = true;
      heartbeat.stop();
      if (timer) clearInterval(timer);
      challenges.clear();
      camera.cancelAll(broadcast);
      agent.cancel();
      approvals.denyAll("Shutting down");
      await gateway.close();
      await provider.close?.().catch(() => {});
      await hub.close().catch(() => {});
      db.close();
    },
  };
}
