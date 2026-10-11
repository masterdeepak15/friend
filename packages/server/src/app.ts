import type { ClientMsg, MusicState, ServerMsg } from "@friend/protocol";
import { Agent, type AgentSettings } from "./agent/loop";
import { HINDI_VOICES, MARATHI_VOICES, clampToSafe, isCatalogVoice, voiceLabel } from "@friend/protocol";
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
import { MediaStore } from "./media";
import { ChannelHub } from "./channels/hub";
import { AlexaHub, fetchAmazonCert } from "./alexa/hub";
import { MusicHub } from "./music/hub";
import { HostPlayer } from "./music/host";
import { MusicLibrary } from "./music/library";
import { Mpv } from "./music/mpv";
import { MusicTokens } from "./music/oauth";
import { LocalSource, MusicSources } from "./music/source";
import { SpotifyHub } from "./music/spotify";
import { buildSkillPackage, packageFileNames } from "./alexa/package";
import { portfolioSpeech, statusSpeech, tasksSpeech } from "./alexa/fast";
import { summarize } from "./brokers/portfolio";
import { BrokerHub } from "./brokers/hub";

const PORTFOLIO_SKILL = "portfolio-assistant";
/** The type each kind of audio file is sent as. */
const MIME: Record<string, string> = { mp3: "audio/mpeg", m4a: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", opus: "audio/ogg; codecs=opus", wav: "audio/wav", flac: "audio/flac" };
import { changeAlexa, changeBroker, changeIntegration, changeSpotify, integrationSummary, integrationViews, isIntegrationId, type IntegrationId } from "./integrations";
import { CodeBox } from "./codebox";
import { Heartbeat } from "./heartbeat";
import { Memory } from "./memory";
import { Plugins, isPluginId, listCatalog } from "./plugins";
import { WeatherService, weatherSummary } from "./weather";
import { dirname, extname, resolve } from "node:path";
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
import { OpenAiProvider } from "./provider/openai";
import type { Provider, ProviderEvent, StreamRequest } from "./provider/types";
import { StageState } from "./stage";
import { dbWidgetStore } from "./widgets";
import { ensureTlsCert } from "./tls";
import { HttpError } from "./http-error";
import { Challenges } from "./voice/challenge";
import { loadOrCreateKey } from "./voice/crypto";
import { EnrollError, Enrollment } from "./voice/enrollment";
import { VoiceError, type VoiceService } from "./voice/service";
import { Speaker } from "./voice/speaker";
import { Voiceprint } from "./voice/voiceprint";
import { Household, HouseholdError, MAX_PEOPLE, decideSpeaker, type WhoSpeaks } from "./voice/household";

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
  /** How Zerodha is reached (tests hand in a fake). */
  brokerFetch?: typeof fetch;
  /** For tests: stands in for Spotify's servers. */
  musicFetch?: typeof fetch;
  /** For tests: stands in for mpv. */
  musicMpv?: ConstructorParameters<typeof HostPlayer>[0]["mpv"] & { reset?: () => void };
  /** How Amazon's signing certificate is downloaded (tests hand in their own). */
  alexaFetchCert?: (url: string) => Promise<string>;
  /** The roots Amazon's certificate must lead to (tests hand in their own). Defaults to the ones Node knows. */
  alexaRoots?: string[];
  /** How often the broker reports and the login reminder are looked at. */
  brokerTickMs?: number;
  /** How long after start the Hindi and Marathi voices are made ready in the background (tests use a long time so it never happens). */
  warmLanguagesAfterMs?: number;
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
  stage.useStore(dbWidgetStore(db)); // the owner's pinned widgets come back
  stage.trackView(() => config.view);
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
    if (config.provider === "openai") return new OpenAiProvider({ ...config.openai });
    return config.apiKey ? new ClaudeProvider({ apiKey: config.apiKey, model: config.model }) : new MissingKeyProvider();
  };
  const switchable = opts.provider ? null : new SwitchableProvider(makeProvider());
  const provider: Provider = opts.provider ?? switchable!;
  const camera = new CameraBroker(opts.cameraTimeoutMs);
  const screenShot = new CameraBroker(opts.cameraTimeoutMs, "screen");
  const media = new MediaStore(db, config.dataDir);
  // files shown earlier are kept while a widget still uses them; the rest are forgotten after a day
  media.prune(new Set(JSON.stringify(stage.snapshot().objects).match(/(?<=\/api\/media\/)[0-9a-f]{32}/g) ?? []));
  // Telegram, SMS and WhatsApp. What the owner writes from their own chat is answered by the same assistant as at the PC.
  const channelHub = new ChannelHub({
    config,
    db,
    audit,
    notify: (m) => broadcast(m),
    ask: async (text, via) => {
      // a plain yes or no from the owner may be the answer to something Alexa asked for permission to do
      if (alexaHub.tryApprove(text)) return "Okay.";
      if (agent.isBusy()) return "I am busy with another request. Try again in a moment.";
      let reply = "";
      const emit = (m: ServerMsg) => {
        broadcast(m);
        if (m.type === "caption.delta") reply += m.text;
        else if (m.type === "caption.end") reply += "\n";
      };
      await agent.runTurn(text, { trust: "owner", emit, ip: `channel:${via}` });
      return reply.trim();
    },
  });
  // Stock brokers (Zerodha first): the daily login, reading the account, and the scheduled reports.
  const brokerHub = new BrokerHub({ config, dataDir: opts.dataDir, db, audit, channels: channelHub, fetch: opts.brokerFetch, publicBase: () => config.publicUrl ?? null });
  brokerHub.apply();
  let brokerTimer: ReturnType<typeof setInterval> | undefined;
  // The owner's music: the folder is a setting; the player itself runs in the browser and the assistant controls it through the hub.
  const musicLibrary = new MusicLibrary({ folder: () => config.music.folder, extensions: () => config.music.extensions, maxTracks: () => config.music.maxTracks, scanDepth: () => config.music.scanDepth });
  const musicTokens = new MusicTokens(opts.dataDir);
  const spotifyHub = new SpotifyHub({ config: () => config, tokens: musicTokens, fetch: opts.musicFetch, publicBase: () => config.publicUrl ?? `http://127.0.0.1:${config.port}` });
  const musicSources = new MusicSources([new LocalSource(musicLibrary), spotifyHub], { defaultSource: () => config.music.defaultSource, searchLimit: () => config.music.searchLimit });
  // The PC's own player (mpv for the folder, a Spotify device for Spotify). It only plays when the owner chose the PC as the output.
  let hostEmit: (state: MusicState) => void = () => {};
  const hostMpv = opts.musicMpv ?? new Mpv({ program: () => config.music.hostPlayer, dataDir: opts.dataDir });
  const hostPlayer = new HostPlayer({ library: musicLibrary, mpv: hostMpv, spotify: spotifyHub, settings: () => config.music, emit: (s) => hostEmit(s) });
  const musicHub = new MusicHub({ library: musicLibrary, sources: musicSources, host: hostPlayer, output: () => config.music.output });
  void musicLibrary.scan().catch(() => {});
  const memory = new Memory(db);
  const tasks = new Tasks(db);
  const plugins = new Plugins(db, join(opts.dataDir, "plugins"));
  const hub = new McpHub(new ConnectorStore(opts.dataDir));
  /** Changes the integrations in memory and in the saved file (only this change reaches the file), then restarts what needs it. Returns the reason it could not be done. */
  const changeChannels = (fn: (c: Config["channels"]) => string | null): string | null => {
    const saved = loadConfig(opts.dataDir);
    const err = fn(saved.channels);
    if (err) return err;
    fn(config.channels);
    saveConfig(saved);
    channelHub.apply();
    return null;
  };
  /** The same for the brokers' part of the saved file. */
  const changeBrokers = (fn: (b: Config["brokers"]) => string | null): string | null => {
    const saved = loadConfig(opts.dataDir);
    const err = fn(saved.brokers);
    if (err) return err;
    fn(config.brokers);
    saveConfig(saved);
    brokerHub.apply();
    return null;
  };
  /** Install, switch on or off, or remove one integration, wherever it keeps its settings. */
  /** The same for the Alexa part of the saved file. */
  const changeAlexaConfig = (fn: (a: Config["alexa"]) => string | null | void): string | null => {
    const saved = loadConfig(opts.dataDir);
    const err = fn(saved.alexa);
    if (typeof err === "string") return err;
    fn(config.alexa);
    saveConfig(saved);
    return null;
  };
  /** The same for the Spotify part of the saved file. */
  const changeSpotifyConfig = (fn: (s: Config["music"]["spotify"]) => string | null | void): string | null => {
    const saved = loadConfig(opts.dataDir);
    const err = fn(saved.music.spotify);
    if (typeof err === "string") return err;
    fn(config.music.spotify);
    saveConfig(saved);
    return null;
  };
  const changeAny = (id: IntegrationId, change: { install: true } | { remove: true } | { enabled: boolean }): string | null => {
    if (id === "alexa") return changeAlexaConfig((a) => changeAlexa(a, change));
    if (id === "spotify") {
      const err = changeSpotifyConfig((s) => changeSpotify(s, change));
      if (!err && "remove" in change) spotifyHub.disconnect();
      return err;
    }
    if (id !== "zerodha") return changeChannels((c) => changeIntegration(c, id, change));
    const err = changeBrokers((b) => changeBroker(b, id, change, (gone) => brokerHub.forget(gone)));
    // the portfolio skill comes and goes with the integration
    if (!err && "install" in change && listCatalog(catalogDir).some((c) => c.id === PORTFOLIO_SKILL)) plugins.install(join(catalogDir, PORTFOLIO_SKILL));
    if (!err && "remove" in change) plugins.remove(PORTFOLIO_SKILL);
    return err;
  };
  const admin = makeAdmin({
    hub,
    plugins,
    dataDir: opts.dataDir,
    audit: (what, detail) => audit.log("agent", what, detail),
    catalog: {
      list: () => {
        const have = new Set(plugins.list().map((p) => p.id));
        return listCatalog(catalogDir).map((c) => ({ id: c.id, name: c.name, version: c.version, description: c.description, installed: have.has(c.id), error: c.error }));
      },
      install: (id) => {
        if (!listCatalog(catalogDir).some((c) => c.id === id)) return { ok: false, error: "That plugin is not in the catalog." };
        return plugins.install(join(catalogDir, id));
      },
    },
    integrations: {
      views: () => integrationViews(config, channelHub, brokerHub, alexaHub, spotifyHub),
      install: (id) => changeAny(id, { install: true }),
      remove: (id) => changeAny(id, { remove: true }),
      configure: (id, { enabled, settings }) => {
        if (!(id === "zerodha" ? config.brokers.zerodha : id === "alexa" ? config.alexa : id === "spotify" ? config.music.spotify : config.channels[id]).installed) return `${id} is not installed yet. Install it first with plugins.install.`;
        if (id !== "zerodha" && id !== "alexa" && id !== "spotify" && Object.keys(settings).length) {
          try {
            commitSettings({ channels: { [id]: settings } }, { actor: "agent" });
          } catch (e) {
            return (e as Error).message;
          }
        }
        return enabled === undefined ? null : changeAny(id, { enabled });
      },
    },
  });
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
    if (applied.changed.some((k) => k.startsWith("channels"))) channelHub.apply();
    if (applied.changed.some((k) => k.startsWith("brokers"))) brokerHub.apply();
    if (applied.changed.some((k) => k.startsWith("music."))) void musicLibrary.scan().catch(() => {});
    // the player that is leaving stops; a new program setting means a fresh mpv
    if (applied.changed.includes("music.output") && config.music.output === "screen") void hostPlayer.stop().catch(() => {});
    if (applied.changed.includes("music.hostPlayer")) void hostPlayer.stop().then(() => (hostMpv as { reset?: () => void }).reset?.()).catch(() => {});
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
    if (applied.changed.includes("voice.hindiVoice")) void warmLanguageVoice(config.voice.hindiVoice);
    if (applied.changed.includes("voice.marathiVoice")) void warmLanguageVoice(config.voice.marathiVoice);
    if (applied.changed.some((k) => k === "view" || k === "ownerName" || k.startsWith("look.") || k.startsWith("hud") || k.startsWith("music"))) {
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

  /** The voice for Hindi or Marathi is loaded in the background when the owner picks it, so the first sentence does not wait for the download. */
  async function warmLanguageVoice(wanted: string): Promise<void> {
    if (!wanted || !voice || !voiceAvailable()) return;
    broadcast({ type: "alert", level: "info", text: `Loading the voice ${voiceLabel(wanted)}. The first time it downloads about 64 MB.` });
    try {
      await voice.synthesize("Ready.", wanted);
      broadcast({ type: "alert", level: "info", text: `The voice ${voiceLabel(wanted)} is ready.` });
    } catch (e) {
      audit.log("system", "voice.load_failed", { voice: wanted, message: (e as Error).message });
      broadcast({ type: "alert", level: "warn", text: `Could not load the voice ${wanted} (it needs internet the first time). That language is read by the main voice for now.` });
    }
  }

  /** At start the Hindi and Marathi voices are made ready quietly (a voice whose download was cut off is repaired here), so the first reply in that language does not wait. */
  let languageWarm: NodeJS.Timeout | null = null;
  const warmLanguagesQuietly = () => {
    for (const wanted of [config.voice.hindiVoice, config.voice.marathiVoice]) {
      if (!wanted || !voice || !voiceAvailable()) continue;
      void voice.synthesize("Ready.", wanted).catch((e: Error) => audit.log("system", "voice.load_failed", { voice: wanted, message: e.message }));
    }
  };

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

  const weatherService = opts.weather ?? new WeatherService();
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
    weather: weatherService,
    code: opts.codeBox ?? new CodeBox(),
    camera: {
      request: (emit, signal) => {
        audit.log("agent", "camera.requested", {});
        return camera.request(emit, signal);
      },
    },
    screen: {
      request: (emit, signal) => {
        audit.log("agent", "screen.requested", {});
        return screenShot.request(emit, signal);
      },
    },
    media,
    channels: channelHub,
    brokers: brokerHub,
    music: musicHub,
    integrations: { summary: () => integrationSummary(integrationViews(config, channelHub, brokerHub, alexaHub, spotifyHub)) },
  });

  const clients = new Set<ClientConn>();
  const broadcast = (m: ServerMsg) => {
    for (const c of clients) c.send(m);
  };
  hostEmit = (state) => broadcast({ type: "music.host", state });
  // Alexa: the owner's own skill talks to this endpoint; fixed questions are answered from the tools, the rest by the assistant.
  const alexaHub = new AlexaHub({
    config,
    store: { config: () => config.alexa, update: (fn) => void changeAlexaConfig(fn) },
    verify: { fetchCert: opts.alexaFetchCert ?? fetchAmazonCert, roots: opts.alexaRoots },
    clock: Date.now,
    agent: { isBusy: () => agent.isBusy(), runTurn: (text, ctx) => agent.runTurn(text, ctx) },
    broadcast,
    screenOpen: () => clients.size > 0,
    fast: {
      PortfolioIntent: async (locale) => {
        const got = await brokerHub.snapshot("zerodha");
        if (!got.ok) return got.sessionExpired ? "Zerodha needs you to log in first." : got.error;
        if (!got.snapshot.holdings.ok) return "I could not read your holdings just now.";
        return portfolioSpeech(summarize(got.snapshot.holdings.data), locale.startsWith("hi") ? "hi" : "en", { money: { symbol: config.brokers.currencySymbol, locale: config.brokers.numberLocale }, currencyName: config.brokers.currencyName });
      },
      WeatherIntent: async (_locale, slots) => {
        if (!slots.city) return "Tell me which city, for example: what is the weather in Pune.";
        const r = await weatherService.get(slots.city);
        return r.ok ? weatherSummary(r.weather) : r.error;
      },
      TasksIntent: async (locale) => tasksSpeech(tasks.list(), locale.startsWith("hi") ? "hi" : "en"),
      StatusIntent: async (locale) => {
        const z = brokerHub.status("zerodha");
        return statusSpeech({ openTasks: tasks.list().length, brokerLoggedIn: z.installed && z.enabled ? z.loggedIn : null }, locale.startsWith("hi") ? "hi" : "en");
      },
    },
    channels: channelHub,
    linked: () => [
      ...(config.channels.telegram.enabled && config.channels.telegram.ownerChatId !== null ? (["telegram"] as const) : []),
      ...(config.channels.twilio.enabled && config.channels.twilio.whatsappFrom && config.channels.twilio.ownerNumber ? (["whatsapp"] as const) : []),
    ],
    respondApproval: (id, approve) => void approvals.respond({ id, decision: approve ? "approve" : "deny" }, "alexa").catch(() => {}),
    audit,
    publicBase: () => config.publicUrl ?? null,
  });
  tellFallback = (reason) => {
    audit.log("system", "provider.fallback", { reason: reason.slice(0, 300) });
    broadcast({ type: "alert", level: "info", text: `${reason} Using the local model for now.` });
  };
  const voice = opts.voice;
  const speaker = voice
    ? new Speaker(voice, audit, () => config.voice.ttsVoice, () => ({ hindi: config.voice.hindiVoice || undefined, marathi: config.voice.marathiVoice || undefined }))
    : null;
  const voiceAvailable = () => !!voice && voice.available();
  // The owner's voiceprint: encrypted at rest, key in a private file next to the database.
  const voiceKey = voice ? loadOrCreateKey(join(opts.dataDir, "voice.key")) : null;
  const voiceprint = voiceKey ? new Voiceprint(db, voiceKey) : null;
  const enrollment = voiceprint ? new Enrollment(voiceprint, SPEAKER_MODEL) : null;
  // The other people of the household (wife, son, daughter...), recognized by voice like the owner is.
  const household = voiceKey ? new Household(db, voiceKey) : null;
  let memberEnrollment: { name: string; enrollment: Enrollment } | null = null;
  const challenges = new Challenges((id) => {
    broadcast({ type: "voice.challenge.end", id });
    broadcast({ type: "alert", level: "info", text: "The voice request timed out and was dropped." });
  });
  let stopped = false;
  const uiMsg = (): ServerMsg => ({
    type: "ui",
    view: config.view,
    look: clientLook(config.look),
    ownerName: config.ownerName,
    assistantName: auth.assistantName(),
    hud: { terminalLabel: config.hud.terminalLabel, clock: { ...config.hud.clock }, launcher: config.hud.launcher.map((l) => ({ ...l, action: { ...l.action } })), animations: config.hud.animations },
    music: { folderSet: config.music.folder !== "", volume: config.music.volume, shuffle: config.music.shuffle, repeat: config.music.repeat, visualizer: config.music.visualizer, startView: config.music.startView, output: config.music.output },
  });
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
  function judge(embedding: number[] | null): WhoSpeaks {
    if (!embedding) return { trust: "challenge" };
    let score: number | null;
    let member: ReturnType<Household["identify"]> = null;
    try {
      score = voiceprint!.score(embedding);
      member = household?.identify(embedding) ?? null;
    } catch (e) {
      audit.log("system", "voice.score_failed", { message: (e as Error).message });
      return { trust: "guest" };
    }
    const who = decideSpeaker(score, member, config.voice);
    // the person is named in the log by number only: the audit trail never holds names or what was said by family members
    audit.log("system", "voice.trust", { trust: who.trust, score: score === null ? null : Math.round(score * 1000) / 1000, ...(who.person ? { person: who.person.id, personScore: Math.round(who.person.score * 1000) / 1000 } : {}) });
    return who;
  }

  /** Runs the turn for something that was said, then speaks the reply. Guests get the isolated guest turn. */
  async function runVoiceTurn(text: string, ip: string, epoch: number, trust: "owner" | "guest" | "member" = "owner", person?: { id: number; name: string }, spoken?: string): Promise<void> {
    // the voice keeps pace with the captions: each sentence is spoken as soon as it has been written
    const talk = speaker?.stream(broadcast);
    const emit = (m: ServerMsg) => {
      if (m.type === "caption.delta" && epoch === lockEpoch) talk?.push(m.text); // locked meanwhile: stay silent
      broadcast(m);
    };
    await agent.runTurn(text, { trust, emit, ip, ...(person ? { person } : {}), ...(spoken ? { spoken } : {}) });
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
      return { installed, catalog: listCatalog(catalogDir).map((c) => ({ ...c, installed: have.has(c.id) })), integrations: integrationViews(config, channelHub, brokerHub, alexaHub, spotifyHub) };
    },
    install: async (id, pin, ip) => {
      if (isIntegrationId(id)) {
        await requirePin(pin, ip);
        const err = changeAny(id, { install: true });
        if (err) throw new HttpError(400, err);
        audit.log("owner", "plugin.installed", { id, integration: true, ip });
        return { id, upgraded: false };
      }
      if (!isPluginId(id)) throw new HttpError(400, "That is not a plugin name.");
      if (!listCatalog(catalogDir).some((c) => c.id === id)) throw new HttpError(404, "That plugin is not in the catalog.");
      await requirePin(pin, ip);
      const r = plugins.install(join(catalogDir, id));
      if (!r.ok) throw new HttpError(400, `That plugin cannot be installed: ${r.error}`);
      audit.log("owner", "plugin.installed", { id: r.id, upgraded: r.upgraded, ip });
      return { id: r.id, upgraded: r.upgraded };
    },
    setEnabled: async (id, enabled, pin, ip) => {
      if (isIntegrationId(id)) {
        if (enabled) {
          if (!pin) throw new HttpError(400, "Enter your PIN to switch a plugin on.");
          await requirePin(pin, ip);
        }
        const err = changeAny(id, { enabled });
        if (err) throw new HttpError(400, err);
        audit.log("owner", enabled ? "plugin.enabled" : "plugin.disabled", { id, integration: true, ip });
        return;
      }
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
      if (isIntegrationId(id)) {
        changeAny(id, { remove: true });
        audit.log("owner", "plugin.removed", { id, integration: true });
        return;
      }
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

  const tls = config.https ? await ensureTlsCert(opts.dataDir, [...config.allowedHosts, ...(config.publicUrl ? [new URL(config.publicUrl).hostname] : [])]) : undefined;
  const gateway = createGateway({
    ...(tls ? { tls } : {}),
    connectors: connectorsApi,
    voicePreview: async (id) => {
      if (!voice || !voiceAvailable()) throw new HttpError(503, "Voice is not available. Run: friend voice setup");
      const indian = [...HINDI_VOICES, ...MARATHI_VOICES].some((v) => v.id === id) || id === config.voice.hindiVoice || id === config.voice.marathiVoice;
      if (!isCatalogVoice(id) && !indian && id !== config.voice.ttsVoice) throw new HttpError(400, "That voice is not in the list.");
      // a Hindi or Marathi voice says a sentence in its own language: an English one would sound wrong
      if (id.startsWith("hi_")) return voice.synthesize("नमस्ते, मैं आपकी सहायक हूँ। मेरी आवाज़ ऐसी है।", id);
      if (id.startsWith("mr_")) return voice.synthesize("नमस्कार, मी तुमची मदतनीस आहे. माझा आवाज असा आहे.", id);
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
      const enrolled = voiceprint?.exists() ?? false; // the owner's voice must be known before anyone else's matters
      let heard: string;
      let embedding: number[] | null = null;
      let spoken: string | undefined;
      try {
        const t = await voice.transcribe(audio, mime, config.voice.language, { embed: enrolled });
        heard = t.text.trim();
        embedding = t.embedding ?? null;
        spoken = t.language; // the language the recognizer heard, so the reply can be in it
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
      const who: WhoSpeaks | { trust: "unverified" } = enrolled ? judge(embedding) : { trust: "unverified" };
      const trust = who.trust;
      if (trust === "member" && "person" in who && who.person) {
        const person = { id: who.person.id, name: who.person.name };
        broadcast({ type: "voice.heard", text: heard, trust: "member", speaker: person.name });
        audit.log("system", "voice.member", { person: person.id }); // never the words: a family member's talk is not logged
        void runVoiceTurn(heard, ip, epoch, "member", person, spoken).catch(crash);
      } else if (trust === "challenge") {
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
        void runVoiceTurn(heard, ip, epoch, "owner", undefined, spoken).catch(crash);
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
    household:
      household && voiceprint && voice
        ? {
            overview: () => ({
              people: household.list(),
              max: MAX_PEOPLE,
              ownerEnrolled: voiceprint.exists(),
              enrolling: memberEnrollment ? { name: memberEnrollment.name, ...memberEnrollment.enrollment.state() } : null,
            }),
            begin: (rawName) => {
              if (!voiceprint.exists()) throw new HttpError(400, "Teach Friend your own voice first (Esc, then Enroll my voice). Then add the others.");
              try {
                const name = household.canAdd(rawName);
                memberEnrollment?.enrollment.cancel();
                const target = { exists: () => false, enroll: (e: readonly (readonly number[])[], model: string) => void household.add(name, e, model), clear: () => {} };
                memberEnrollment = { name, enrollment: new Enrollment(target, SPEAKER_MODEL) };
                return { name, ...memberEnrollment.enrollment.state() };
              } catch (e) {
                if (e instanceof HouseholdError) throw new HttpError(400, e.message);
                throw e;
              }
            },
            sample: async (audio, mime) => {
              const current = memberEnrollment;
              if (!current) throw new HttpError(400, "Choose a name first.");
              let embedding: number[];
              try {
                embedding = (await voice.embed(audio, mime)).embedding;
              } catch (e) {
                if (e instanceof VoiceError) throw new HttpError(400, e.message);
                throw e;
              }
              try {
                return current.enrollment.add(embedding);
              } catch (e) {
                if (e instanceof EnrollError) throw new HttpError(400, e.message);
                throw e;
              }
            },
            finish: async (pin, ip) => {
              const current = memberEnrollment;
              if (!current) throw new HttpError(400, "Choose a name first.");
              await requirePin(pin, ip);
              try {
                const out = current.enrollment.finish();
                memberEnrollment = null;
                audit.log("owner", "voice.person_added", { ip, samples: out.samples });
                broadcast(statusMsg());
                return { ...out, name: current.name };
              } catch (e) {
                if (e instanceof EnrollError || e instanceof HouseholdError) throw new HttpError(400, e.message);
                throw e;
              }
            },
            cancel: () => {
              memberEnrollment?.enrollment.cancel();
              memberEnrollment = null;
            },
            remove: async (id, pin, ip) => {
              await requirePin(pin, ip);
              if (!household.remove(id)) throw new HttpError(404, "That person is not saved.");
              audit.log("owner", "voice.person_removed", { ip, person: id });
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
    onScreenFrame: (id, jpeg) => {
      const out = screenShot.deliver(id, jpeg);
      if (out === "ok") {
        audit.log("owner", "screen.frame", { bytes: jpeg.length }); // size only, never pixels
        broadcast({ type: "screen.cancel", id });
      } else {
        audit.log("owner", "screen.frame_ignored", { reason: out, bytes: jpeg.length });
      }
      return out;
    },
    media: { lookup: (id) => media.lookup(id) },
    channels: {
      status: () => ({ ...channelHub.status(), unread: channelHub.unreadCount() }),
      link: async (pin, ip) => {
        if (!pin) throw new HttpError(400, "Enter your PIN to link Telegram");
        await requirePin(pin, ip);
        if (!config.channels.telegram.enabled || !config.channels.telegram.botToken) throw new HttpError(400, "Switch Telegram on and save the bot token first");
        audit.log("owner", "channel.link_started", { ip });
        return channelHub.linkTelegram();
      },
      unlink: async (pin, ip) => {
        if (!pin) throw new HttpError(400, "Enter your PIN to unlink Telegram");
        await requirePin(pin, ip);
        channelHub.unlinkTelegram();
        return { ok: true };
      },
      twilioInbound: (url, params, signature) => channelHub.handleTwilio(url, params, signature),
    },
    music: {
      library: async (q) => {
        await musicLibrary.ready();
        const stats = musicLibrary.stats();
        return { ...musicLibrary.list(q), folderSet: stats.folderSet, library: { tracks: stats.tracks, artists: stats.artists, albums: stats.albums, scannedAt: stats.scannedAt } };
      },
      track: async (id) => {
        await musicLibrary.ready();
        const path = await musicLibrary.resolve(id);
        return path ? { path, mime: MIME[extname(path).slice(1).toLowerCase()] ?? "application/octet-stream" } : null;
      },
      cover: async (id) => {
        await musicLibrary.ready();
        return musicLibrary.cover(id);
      },
      rescan: () => musicLibrary.scan(),
      sources: () => ({
        sources: Object.entries(musicSources.status()).map(([id, status]) => ({ id, status })),
        spotify: { redirectUri: spotifyHub.redirectUri(), clientId: config.music.spotify.clientId },
      }),
      search: async (q) => musicSources.search(q.q, { ...(q.source ? { source: q.source } : {}), ...(q.limit ? { limit: q.limit } : {}) }),
      spotifyConnect: async (pin, ip) => {
        await requirePin(pin, ip);
        const st = spotifyHub.status();
        if (!config.music.spotify.installed || !config.music.spotify.enabled) throw new HttpError(400, st.needs ?? "Install and switch on Spotify in Plugins.");
        const url = spotifyHub.connectUrl();
        if (!url) throw new HttpError(400, "Add your Spotify client id first, in Plugins, Spotify.");
        audit.log("owner", "music.spotify.connect", { ip });
        return { url };
      },
      spotifySetClientId: async (clientId, pin, ip) => {
        await requirePin(pin, ip);
        const id = clientId.trim();
        if (!/^[A-Za-z0-9]{8,64}$/.test(id)) throw new HttpError(400, "A Spotify client id is letters and digits only. Copy it from your app at developer.spotify.com.");
        if (!config.music.spotify.installed) throw new HttpError(400, "Install Spotify from Plugins first.");
        const changed = id !== config.music.spotify.clientId;
        changeSpotifyConfig((s) => {
          s.clientId = id;
        });
        if (changed) spotifyHub.disconnect(); // a login belongs to the app it was made for
        audit.log("owner", "music.spotify.clientid", { ip });
        return { ok: true };
      },
      spotifyToken: async () => (spotifyHub.status().connected ? spotifyHub.accessToken() : null),
      spotifyDisconnect: async (pin, ip) => {
        await requirePin(pin, ip);
        spotifyHub.disconnect();
        audit.log("owner", "music.spotify.disconnect", { ip });
        return { ok: true };
      },
      spotifyCallback: async (params) => {
        const r = await spotifyHub.completeLogin(params);
        audit.log("owner", r.ok ? "music.spotify.connected" : "music.spotify.failed", {});
        return r.ok;
      },
    },
    alexa: {
      handle: (raw, headers) => alexaHub.handle(raw, headers),
      status: () => alexaHub.status(),
      allow: async (short, name, pin, ip) => {
        await requirePin(pin, ip);
        if (!alexaHub.devices.allow(short, name || `Echo ${short.slice(-4)}`)) throw new HttpError(404, "That Echo is not waiting, or the list is full.");
        audit.log("owner", "alexa.allowed", { ip });
        return { ok: true };
      },
      forget: (short) => {
        const gone = alexaHub.devices.forget(short);
        if (gone) audit.log("owner", "alexa.forgotten", {});
        return gone;
      },
      packageFile: (name) => {
        const endpoint = alexaHub.endpoint();
        if (!packageFileNames(config.alexa.locales).includes(name) || !endpoint || !config.alexa.invocationName) return null;
        try {
          const text = buildSkillPackage({ invocationName: config.alexa.invocationName, endpoint, skillName: config.alexa.skillName, locales: config.alexa.locales })[name];
          return text ? { type: "application/json", text } : null;
        } catch {
          return null;
        }
      },
    },
    brokers: {
      status: () => ({ zerodha: brokerHub.status("zerodha"), schedules: brokerHub.schedules.list(), redirectUrl: brokerHub.redirectUrl("zerodha"), timezone: config.brokers.timezone }),
      callback: async (params) => (await brokerHub.completeLogin(params)).ok,
      loginLink: async (send) => {
        const url = brokerHub.loginLink("zerodha");
        if (!url) throw new HttpError(400, "Install Zerodha, add the API key and secret, and switch it on first.");
        if (!send) return { url };
        const channel = brokerHub.schedules.list()[0]?.channel ?? "telegram";
        const sent = await channelHub.send(channel, "me", `Log in to Zerodha:\n${url}`);
        if (!sent.ok) throw new HttpError(400, sent.error);
        return { sent: true, via: channel };
      },
      schedules: () => brokerHub.schedules.list(),
      addSchedule: async (input, pin, ip) => {
        await requirePin(pin, ip);
        try {
          const made = brokerHub.schedules.add({ broker: "zerodha", days: [1, 2, 3, 4, 5], commentary: false, enabled: true, ...(input as object) } as Parameters<typeof brokerHub.schedules.add>[0]);
          audit.log("owner", "broker.schedule_added", { name: made.name, kind: made.kind, time: made.time, channel: made.channel, ip });
          return made;
        } catch (e) {
          throw new HttpError(400, (e as Error).message);
        }
      },
      removeSchedule: (id) => {
        const gone = brokerHub.schedules.remove(id);
        if (gone) audit.log("owner", "broker.schedule_removed", { id });
        return gone;
      },
      run: async (kind, send) => {
        const r = await brokerHub.report("zerodha", (kind ?? "custom") as "morning" | "close" | "custom");
        if (!r.ok) return { status: r.sessionExpired ? 409 : 400, body: { error: r.error, ...(r.sessionExpired ? { sessionExpired: true } : {}) } };
        if (send) {
          const sent = await channelHub.send(brokerHub.schedules.list()[0]?.channel ?? "telegram", "me", r.text);
          if (!sent.ok) return { status: 400, body: { error: sent.error } };
        }
        return { status: 200, body: { text: r.text } };
      },
    },
    onClientConnect: (_session, conn) => {
      clients.add(conn);
      musicHub.attach(conn);
      conn.send({ type: "snapshot", stage: stage.snapshot(), pendingApproval: approvals.pending() });
      conn.send(statusMsg());
      conn.send(uiMsg());
      conn.send({ type: "music.host", state: hostPlayer.state() });
      const pending = challenges.current();
      if (pending) conn.send({ type: "voice.challenge", id: pending.id, text: pending.text });
      return () => {
        clients.delete(conn);
        musicHub.detach(conn);
      };
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
        case "screen.denied":
          if (screenShot.deny(msg.id, msg.reason)) {
            audit.log("owner", "screen.denied", { reason: msg.reason });
            broadcast({ type: "screen.cancel", id: msg.id });
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
        case "ui.screen":
          stage.setScreen(msg);
          break;
        case "music.state":
          musicHub.onState(conn, msg.state);
          break;
        case "music.remote":
          // a button on a screen, for the PC's own player; only while the owner chose the PC as the output
          if (config.music.output !== "host") break;
          void hostPlayer.command(msg.command).then((r) => {
            if (!r.ok) conn.send({ type: "alert", level: "warn", text: r.text });
          });
          break;
        case "stage.move": {
          // the owner dragged or resized an object: it keeps the box they left it in, kept inside the safe part of the screen
          const [x, y, w, h] = clampToSafe([msg.rect.x * 100, msg.rect.y * 100, msg.rect.w * 100, msg.rect.h * 100]);
          const command = { cmd: "place" as const, id: msg.objectId, placement: { x: x / 100, y: y / 100, w: w / 100, h: h / 100 } };
          if (stage.apply(command, Date.now(), true).ok) broadcast({ type: "stage", command });
          break;
        }
        case "stage.pin": {
          const command = { cmd: msg.pinned ? ("pin" as const) : ("unpin" as const), id: msg.objectId };
          const done = stage.apply(command, Date.now(), true);
          if (done.ok) broadcast({ type: "stage", command });
          else conn.send({ type: "alert", level: "warn", text: done.error });
          audit.log("owner", msg.pinned ? "stage.pin" : "stage.unpin", { objectId: msg.objectId });
          break;
        }
        case "ping":
          conn.send(statusMsg());
          break;
        case "stage.event":
          audit.log("owner", "stage.event", { objectId: msg.objectId, event: msg.event });
          if (msg.event === "dismiss") {
            // the owner's own X: this removes even a pinned widget, for good
            const done = stage.apply({ cmd: "hide", id: msg.objectId }, Date.now(), true);
            if (done.ok) {
              broadcast({ type: "stage", command: { cmd: "hide", id: msg.objectId } });
              for (const follow of done.follow ?? []) broadcast({ type: "stage", command: follow });
            }
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
      screenShot.cancelAll(broadcast);
      agent.cancel();
      speaker?.interrupt(broadcast);
      approvals.denyAll("Emergency lock");
      for (const c of [...clients]) c.close(4401, "locked");
    },
  });

  let timer: NodeJS.Timeout | null = null;

  return {
    /** The PC's own music player (also used by tests). */
    musicHost: hostPlayer,
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
    /** Telegram, SMS and WhatsApp. */
    channels: channelHub,
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
      channelHub.apply(); // Telegram starts listening when it is switched on
      brokerTimer = setInterval(() => void brokerHub.tick(new Date()).catch(() => {}), opts.brokerTickMs ?? 60_000);
      brokerTimer.unref?.();
      languageWarm = setTimeout(warmLanguagesQuietly, opts.warmLanguagesAfterMs ?? 20_000);
      timer = setInterval(() => {
        const gone = stage.expire();
        for (const id of gone) broadcast({ type: "stage", command: { cmd: "hide", id } });
        if (gone.length) for (const follow of stage.settleNow()) broadcast({ type: "stage", command: follow });
      }, opts.expireIntervalMs ?? 1000);
      return gateway.listen();
    },
    async stop(): Promise<void> {
      stopped = true;
      hostPlayer.dispose();
      heartbeat.stop();
      channelHub.stop();
      if (brokerTimer) clearInterval(brokerTimer);
      if (languageWarm) clearTimeout(languageWarm);
      if (timer) clearInterval(timer);
      challenges.clear();
      camera.cancelAll(broadcast);
      screenShot.cancelAll(broadcast);
      agent.cancel();
      approvals.denyAll("Shutting down");
      // connectors, the provider and the web server close side by side, so the slowest one sets the time, not their sum
      await Promise.all([gateway.close().catch(() => {}), provider.close?.().catch(() => {}), hub.close().catch(() => {})]);
      db.close();
    },
  };
}
