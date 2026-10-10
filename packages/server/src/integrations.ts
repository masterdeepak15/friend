import type { ChannelHub } from "./channels/hub";
import { DEFAULT_CHANNELS, type ChannelsConfig, type Config } from "./config";

/** Built-in integrations that are added from the plugins screen (or by the assistant, with the owner's approval) and then configured. */
export type IntegrationId = "telegram" | "twilio";
export const INTEGRATION_IDS: readonly IntegrationId[] = ["telegram", "twilio"];
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
};

/** What can be changed without a secret. The AI may set these (with the owner's PIN); tokens only the owner types on the screen. */
export const PUBLIC_SETTINGS: Record<IntegrationId, readonly string[]> = {
  telegram: [],
  twilio: ["accountSid", "smsFrom", "whatsappFrom", "ownerNumber"],
};

export function integrationViews(config: Config, hub: Pick<ChannelHub, "status">): IntegrationView[] {
  const status = hub.status();
  const t = config.channels.telegram;
  const w = config.channels.twilio;
  const publicUrl = config.publicUrl;

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
  ];
}

/** A copy of one integration reset to how a never-installed one looks (this also forgets its tokens). */
const blank = (id: IntegrationId): ChannelsConfig[IntegrationId] => ({ ...DEFAULT_CHANNELS[id] });

/** Changes one integration in a config object. Returns a sentence when it cannot be done. */
export function changeIntegration(channels: ChannelsConfig, id: IntegrationId, change: { install: true } | { remove: true } | { enabled: boolean }): string | null {
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

/** Plain words about every integration, for the assistant's context. */
export function integrationSummary(views: IntegrationView[]): string {
  return `Integrations (plugins you can install and set up for the owner with the integrations tools): ${views.map((v) => `${v.name} (${v.id}): ${v.state === "not-installed" ? "not installed" : `${v.state}${v.detail ? ` - ${v.detail}` : ""}`}`).join("; ")}.`;
}
