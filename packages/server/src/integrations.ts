import type { AlexaHub } from "./alexa/hub";
import type { BrokerHub } from "./brokers/hub";
import type { ChannelHub } from "./channels/hub";
import type { AudiusHub } from "./music/audius";
import type { SoundCloudHub } from "./music/soundcloud";
import type { SpotifyHub } from "./music/spotify";
import { DEFAULT_CHANNELS, type AlexaConfig, type BrokersConfig, type ChannelsConfig, type Config, type MusicConfig } from "./config";

/** Built-in integrations that are added from the plugins screen (or by the assistant, with the owner's approval) and then configured. */
export type ChannelIntegrationId = "telegram" | "twilio";
export type IntegrationId = ChannelIntegrationId | "zerodha" | "alexa" | "spotify" | "soundcloud" | "audius";
export const INTEGRATION_IDS: readonly IntegrationId[] = ["telegram", "twilio", "zerodha", "alexa", "spotify", "soundcloud", "audius"];
export const isIntegrationId = (id: unknown): id is IntegrationId => typeof id === "string" && (INTEGRATION_IDS as readonly string[]).includes(id);

export interface IntegrationStep {
  text: string;
  done: boolean;
}

export interface IntegrationView {
  id: IntegrationId;
  name: string;
  description: string;
  kind: "integration";
  installed: boolean;
  enabled: boolean;
  /** not-installed, needs-setup (something is missing), off, connecting, online or error. */
  state: "not-installed" | "needs-setup" | "off" | "connecting" | "online" | "error";
  /** One line for the owner: what is wrong or what to do next. */
  detail: string;
  /** What setting it up takes, in order, with what is already done. */
  steps: IntegrationStep[];
  /** The settings that are not secret (a phone number, an account name). Secrets are never listed, only whether they are set. */
  settings: Record<string, string | boolean>;
  secrets: Record<string, boolean>;
}

const META: Record<IntegrationId, { name: string; description: string }> = {
  telegram: { name: "Telegram", description: "Talk to Friend from your phone through Telegram, and let it message people for you. Needs a free bot token from @BotFather." },
  twilio: { name: "WhatsApp and SMS (Twilio)", description: "Talk to Friend by WhatsApp or SMS, and let it message people for you. Needs a Twilio account and a public address for Friend." },
  alexa: { name: "Alexa", description: "Talk to Friend from your Echo devices with a free skill of your own: ask by voice and hear the answer. Anything risky is refused, or asked on your phone first." },
  spotify: { name: "Spotify", description: "Play and search your own Spotify account from Friend: ask for a song, an artist or a playlist. Sign-in is through Spotify's own page. Playing needs Spotify Premium on your account, and a free app of your own at developer.spotify.com." },
  soundcloud: { name: "SoundCloud", description: "Play and search your own SoundCloud account from Friend: ask for a track or an artist. Sign-in is through SoundCloud's own page. Needs a free app of your own at soundcloud.com/you/apps (SoundCloud decides who gets one), and some tracks only play with the right SoundCloud plan." },
  audius: { name: "Audius", description: "Free music from Audius, an open music service: ask for a track or an artist. No account, no key and no payment: install it and switch it on. Mostly independent artists." },
  zerodha: { name: "Zerodha", description: "Read-only look at your Zerodha portfolio: ask Friend how it is doing, or have a report sent to Telegram or WhatsApp every morning and at market close. Friend cannot place orders. Needs a free Kite Connect app." },
};

/** What can be changed without a secret. The AI may set these (with the owner's PIN); tokens only the owner types on the screen. */
export const PUBLIC_SETTINGS: Record<IntegrationId, readonly string[]> = {
  telegram: [],
  twilio: ["accountSid", "smsFrom", "whatsappFrom", "ownerNumber"],
  zerodha: [],
  alexa: [],
  spotify: [],
  soundcloud: [],
  audius: [],
};

export function integrationViews(config: Config, hub: Pick<ChannelHub, "status">, brokers?: Pick<BrokerHub, "status">, alexa?: Pick<AlexaHub, "status">, spotify?: Pick<SpotifyHub, "status">, soundcloud?: Pick<SoundCloudHub, "status"> & { secretSet(): boolean }, audius?: Pick<AudiusHub, "status">): IntegrationView[] {
  const status = hub.status();
  const t = config.channels.telegram;
  const w = config.channels.twilio;
  const publicUrl = config.publicUrl;
  const z = config.brokers.zerodha;
  const zs = brokers?.status("zerodha");
  const al = config.alexa;
  const as = alexa?.status();
  const sp = config.music.spotify;
  const sps = spotify?.status();
  const spSteps: IntegrationStep[] = [
    { text: "Create a free app at developer.spotify.com/dashboard and add the redirect address shown in Configure.", done: !!sp.clientId },
    { text: "Paste the app's Client ID in Configure and save.", done: !!sp.clientId },
    { text: "Switch the plugin on.", done: sp.enabled },
    { text: "Press Connect in Configure and allow Friend in Spotify.", done: !!sps?.connected },
  ];
  const au = config.music.audius;
  const aus = audius?.status();
  const auSteps: IntegrationStep[] = [
    { text: "Install it. There is nothing to sign in to and nothing to pay.", done: au.installed },
    { text: "Switch the plugin on.", done: au.enabled },
  ];
  const auState = (): Pick<IntegrationView, "state" | "detail"> => {
    if (!au.installed) return { state: "not-installed", detail: "" };
    if (!au.enabled) return { state: "off", detail: "Switched off." };
    return aus?.connected ? { state: "online", detail: "Ready." } : { state: "needs-setup", detail: aus?.needs ?? "Switch it on." };
  };
  const sc = config.music.soundcloud;
  const scs = soundcloud?.status();
  const scSecret = soundcloud?.secretSet() ?? false;
  const scSteps: IntegrationStep[] = [
    { text: "Register a free app at soundcloud.com/you/apps (SoundCloud decides who gets one) and add the redirect address shown in Configure.", done: !!sc.clientId },
    { text: "Paste the app's Client ID and Client Secret in Configure and save.", done: !!sc.clientId && scSecret },
    { text: "Switch the plugin on.", done: sc.enabled },
    { text: "Press Connect in Configure and allow Friend in SoundCloud.", done: !!scs?.connected },
  ];
  const scState = (): Pick<IntegrationView, "state" | "detail"> => {
    if (!sc.installed) return { state: "not-installed", detail: "" };
    if (!sc.clientId || !scSecret) return { state: "needs-setup", detail: "Add your SoundCloud client id and secret (press Configure)." };
    if (!sc.enabled) return { state: "off", detail: "Switched off." };
    if (!scs?.connected) return { state: "needs-setup", detail: scs?.needs ?? "Connect your SoundCloud account (press Configure)." };
    return { state: "online", detail: scs.needs ?? "Connected." };
  };
  const spState = (): Pick<IntegrationView, "state" | "detail"> => {
    if (!sp.installed) return { state: "not-installed", detail: "" };
    if (!sp.clientId) return { state: "needs-setup", detail: "Add your Spotify client id (press Configure)." };
    if (!sp.enabled) return { state: "off", detail: "Switched off." };
    if (!sps?.connected) return { state: "needs-setup", detail: sps?.needs ?? "Connect your Spotify account (press Configure)." };
    return { state: "online", detail: sps.needs ?? "Connected." };
  };
  const aSteps: IntegrationStep[] = [
    { text: "Create a free skill in the Alexa developer console: custom model, provision your own.", done: !!al.skillId },
    { text: "Download the skill files in Configure, paste them in the console, and set the endpoint shown there.", done: !!al.skillId && !!al.invocationName },
    { text: "Enter the Skill ID and the invocation name in Configure and save.", done: !!al.skillId && !!al.invocationName },
    { text: "Switch the plugin on.", done: al.enabled },
    { text: "Say \"Alexa, ask <your name>\" on your Echo once, then press Allow next to it in Configure.", done: al.allowedUsers.length > 0 },
  ];
  const alState = (): Pick<IntegrationView, "state" | "detail"> => {
    if (!al.installed) return { state: "not-installed", detail: "" };
    if (!al.skillId || !al.invocationName) return { state: "needs-setup", detail: "Add the skill id and the invocation name (press Configure)." };
    if (!al.enabled) return { state: "off", detail: "Switched off." };
    if (!al.allowedUsers.length) return { state: "needs-setup", detail: `Say "Alexa, ask ${al.invocationName}" once, then allow your Echo (press Configure).${as && as.waiting.length ? " One is waiting." : ""}` };
    return { state: "online", detail: `Ready. Say "Alexa, ask ${al.invocationName}".` };
  };

  const tgSteps: IntegrationStep[] = [
    { text: "Create a bot: open Telegram, talk to @BotFather, send /newbot, and copy the token it gives you.", done: !!t.botToken },
    { text: "Paste the token in Configure and save.", done: !!t.botToken },
    { text: "Switch the plugin on.", done: t.enabled },
    { text: "Link your own Telegram: press \"Get a link code\" and send /link CODE to your bot.", done: t.ownerChatId !== null },
  ];
  const twSteps: IntegrationStep[] = [
    { text: "Create a Twilio account and copy the Account SID and Auth token from its console.", done: !!w.accountSid && !!w.authToken },
    { text: "Get a Twilio number for SMS, or a WhatsApp sender, and enter it in Configure.", done: !!w.smsFrom || !!w.whatsappFrom },
    { text: "Enter your own phone number, so only you can talk to Friend.", done: !!w.ownerNumber },
    { text: "Give Friend a public address (friend config set publicUrl https://…) and set it as the \"a message comes in\" webhook in Twilio.", done: !!publicUrl },
    { text: "Switch the plugin on.", done: w.enabled },
  ];

  const zSteps: IntegrationStep[] = [
    { text: "Create a free Kite Connect app at developers.kite.trade and set its redirect URL to the address shown in Configure.", done: !!z.apiKey && !!z.apiSecret },
    { text: "Paste the app's API key and secret in Configure and save.", done: !!z.apiKey && !!z.apiSecret },
    { text: "Switch the plugin on.", done: z.enabled },
    { text: "Log in to Zerodha with the link in Configure. Zerodha ends the login every morning, so this is once a day.", done: !!zs?.loggedIn },
  ];
  const zState = (): Pick<IntegrationView, "state" | "detail"> => {
    if (!z.installed) return { state: "not-installed", detail: "" };
    if (!z.apiKey || !z.apiSecret) return { state: "needs-setup", detail: "Add your Kite API key and secret (press Configure)." };
    if (!z.enabled) return { state: "off", detail: "Switched off." };
    if (!zs?.loggedIn) return { state: "needs-setup", detail: "Log in to Zerodha (press Configure). Zerodha asks for this once a day." };
    return { state: "online", detail: "Logged in until 06:00 tomorrow. Friend can read your portfolio, never trade." };
  };

  const tgState = (): Pick<IntegrationView, "state" | "detail"> => {
    if (!t.installed) return { state: "not-installed", detail: "" };
    if (!t.botToken) return { state: "needs-setup", detail: "Add the bot token (press Configure)." };
    if (!t.enabled) return { state: "off", detail: "Switched off." };
    const s = status.telegram;
    if (s.state === "error") return { state: "error", detail: s.detail || "Telegram is not answering." };
    if (s.state !== "online") return { state: "connecting", detail: "Connecting…" };
    return { state: "online", detail: `Connected${s.bot ? ` as @${s.bot}` : ""}.${t.ownerChatId === null ? " Link your Telegram to talk to Friend from it." : " Your Telegram is linked."}` };
  };
  const twState = (): Pick<IntegrationView, "state" | "detail"> => {
    if (!w.installed) return { state: "not-installed", detail: "" };
    if (!w.accountSid || !w.authToken) return { state: "needs-setup", detail: "Add the account SID and auth token (press Configure)." };
    if (!w.smsFrom && !w.whatsappFrom) return { state: "needs-setup", detail: "Add a Twilio number for SMS or WhatsApp." };
    if (!w.enabled) return { state: "off", detail: "Switched off." };
    if (!publicUrl) return { state: "needs-setup", detail: "Friend needs a public address so Twilio can reach it (friend config set publicUrl https://…)." };
    return { state: "online", detail: `Ready. Twilio should post incoming messages to ${status.twilio.webhook ?? publicUrl}.${w.ownerNumber ? "" : " Add your own number so you can talk to Friend from it."}` };
  };

  return [
    { id: "telegram", ...META.telegram, kind: "integration", installed: t.installed, enabled: t.enabled, ...tgState(), steps: tgSteps, settings: {}, secrets: { botToken: !!t.botToken, linked: t.ownerChatId !== null } },
    {
      id: "twilio",
      ...META.twilio,
      kind: "integration",
      installed: w.installed,
      enabled: w.enabled,
      ...twState(),
      steps: twSteps,
      settings: { accountSid: w.accountSid, smsFrom: w.smsFrom, whatsappFrom: w.whatsappFrom, ownerNumber: w.ownerNumber },
      secrets: { authToken: !!w.authToken },
    },
    { id: "zerodha", ...META.zerodha, kind: "integration", installed: z.installed, enabled: z.enabled, ...zState(), steps: zSteps, settings: { apiKey: z.apiKey }, secrets: { apiSecret: !!z.apiSecret } },
    { id: "alexa", ...META.alexa, kind: "integration", installed: al.installed, enabled: al.enabled, ...alState(), steps: aSteps, settings: { skillId: al.skillId, invocationName: al.invocationName }, secrets: {} },
    { id: "spotify", ...META.spotify, kind: "integration", installed: sp.installed, enabled: sp.enabled, ...spState(), steps: spSteps, settings: { clientId: sp.clientId }, secrets: {} },
    { id: "soundcloud", ...META.soundcloud, kind: "integration", installed: sc.installed, enabled: sc.enabled, ...scState(), steps: scSteps, settings: { clientId: sc.clientId }, secrets: { clientSecret: scSecret } },
    { id: "audius", ...META.audius, kind: "integration", installed: au.installed, enabled: au.enabled, ...auState(), steps: auSteps, settings: {}, secrets: {} },
  ];
}

/** A copy of one integration reset to how a never-installed one looks (this also forgets its tokens). */
const blank = (id: ChannelIntegrationId): ChannelsConfig[ChannelIntegrationId] => ({ ...DEFAULT_CHANNELS[id] });

/** Changes one integration in a config object. Returns a sentence when it cannot be done. */
export function changeIntegration(channels: ChannelsConfig, id: ChannelIntegrationId, change: { install: true } | { remove: true } | { enabled: boolean }): string | null {
  if ("install" in change) {
    channels[id].installed = true;
    return null;
  }
  if ("remove" in change) {
    (channels as unknown as Record<string, unknown>)[id] = blank(id);
    return null;
  }
  if (!channels[id].installed) return `${META[id].name} is not installed yet.`;
  if (change.enabled) {
    if (id === "telegram" && !channels.telegram.botToken) return "Add the bot token first (Configure), then switch it on.";
    if (id === "twilio" && (!channels.twilio.accountSid || !channels.twilio.authToken)) return "Add the Twilio account SID and auth token first (Configure), then switch it on.";
  }
  channels[id].enabled = change.enabled;
  return null;
}

/** The same for a broker. Removing forgets its key and secret and calls `onRemove` (to delete the saved login); the owner's other broker settings stay. */
export function changeBroker(brokers: BrokersConfig, id: "zerodha", change: { install: true } | { remove: true } | { enabled: boolean }, onRemove?: (id: "zerodha") => void): string | null {
  const z = brokers[id];
  if ("install" in change) {
    z.installed = true;
    return null;
  }
  if ("remove" in change) {
    brokers[id] = { installed: false, enabled: false, apiKey: "", apiSecret: null };
    onRemove?.(id);
    return null;
  }
  if (!z.installed) return `${META[id].name} is not installed yet.`;
  if (change.enabled && (!z.apiKey || !z.apiSecret)) return "Add the Kite API key and secret first (Configure), then switch it on.";
  z.enabled = change.enabled;
  return null;
}

/** The same for Alexa. Removing forgets the skill id, the name and every allowed Echo. */
export function changeAlexa(alexa: AlexaConfig, change: { install: true } | { remove: true } | { enabled: boolean }): string | null {
  if ("install" in change) {
    alexa.installed = true;
    return null;
  }
  if ("remove" in change) {
    Object.assign(alexa, { installed: false, enabled: false, skillId: "", invocationName: "", allowedUsers: [] });
    return null;
  }
  if (!alexa.installed) return `${META.alexa.name} is not installed yet.`;
  if (change.enabled && (!alexa.skillId || !alexa.invocationName)) return "Add the skill id and the invocation name first (Configure), then switch it on.";
  alexa.enabled = change.enabled;
  return null;
}

/** The same for Spotify. Removing forgets the client id (the caller also forgets the login). */
export function changeSpotify(spotify: MusicConfig["spotify"], change: { install: true } | { remove: true } | { enabled: boolean }): string | null {
  if ("install" in change) {
    spotify.installed = true;
    return null;
  }
  if ("remove" in change) {
    Object.assign(spotify, { installed: false, enabled: false, clientId: "" });
    return null;
  }
  if (!spotify.installed) return `${META.spotify.name} is not installed yet.`;
  if (change.enabled && !spotify.clientId) return "Add your Spotify client id first (Configure), then switch it on.";
  spotify.enabled = change.enabled;
  return null;
}

/** The same for SoundCloud. Removing forgets the client id (the caller also forgets the login and the secret). */
export function changeSoundcloud(soundcloud: MusicConfig["soundcloud"], change: { install: true } | { remove: true } | { enabled: boolean }, secretSet: boolean): string | null {
  if ("install" in change) {
    soundcloud.installed = true;
    return null;
  }
  if ("remove" in change) {
    Object.assign(soundcloud, { installed: false, enabled: false, clientId: "" });
    return null;
  }
  if (!soundcloud.installed) return `${META.soundcloud.name} is not installed yet.`;
  if (change.enabled && (!soundcloud.clientId || !secretSet)) return "Add your SoundCloud client id and secret first (Configure), then switch it on.";
  soundcloud.enabled = change.enabled;
  return null;
}

/** The same for Audius: installed and switched on, nothing else to set. */
export function changeAudius(audius: MusicConfig["audius"], change: { install: true } | { remove: true } | { enabled: boolean }): string | null {
  if ("install" in change) {
    audius.installed = true;
    return null;
  }
  if ("remove" in change) {
    Object.assign(audius, { installed: false, enabled: false });
    return null;
  }
  if (!audius.installed) return `${META.audius.name} is not installed yet.`;
  audius.enabled = change.enabled;
  return null;
}

/** Plain words about the integrations the assistant can set up, for its context. Spotify is left out: only the owner connects it. */
export function integrationSummary(views: IntegrationView[]): string {
  return `Integrations (plugins you can install and set up for the owner with the integrations tools): ${views.filter((v) => v.id !== "spotify" && v.id !== "soundcloud" && v.id !== "audius").map((v) => `${v.name} (${v.id}): ${v.state === "not-installed" ? "not installed" : `${v.state}${v.detail ? ` - ${v.detail}` : ""}`}`).join("; ")}.`;
}
