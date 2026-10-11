import type { ServerMsg, Trust } from "@friend/protocol";
import type { Audit } from "../audit";
import type { ChannelHub } from "../channels/hub";
import type { Config } from "../config";
import { AlexaDevices, type AlexaDevicesStore } from "./devices";
import { AlexaEngine, type AlexaReply, type EngineDeps } from "./engine";
import { packageFileNames } from "./package";
import { VoicePermission } from "./permission";
import { langOf, say } from "./phrases";
import { verifyAlexaRequest, type AlexaRequestBody, type VerifyOptions } from "./verify";

export interface AlexaHubDeps {
  config: Config;
  store: AlexaDevicesStore;
  verify: Pick<VerifyOptions, "fetchCert" | "roots">;
  clock: () => number;
  agent: { isBusy(): boolean; runTurn(text: string, ctx: { trust: Trust; emit: (m: ServerMsg) => void; ip: string }): Promise<void> };
  broadcast(m: ServerMsg): void;
  screenOpen(): boolean;
  fast: EngineDeps["fast"];
  channels: Pick<ChannelHub, "send">;
  linked(): ("telegram" | "whatsapp")[];
  respondApproval(id: string, approve: boolean): void;
  audit: Audit;
  publicBase(): string | null;
}

export interface AlexaStatus {
  installed: boolean;
  enabled: boolean;
  skillIdSet: boolean;
  invocationName: string;
  /** The address to give Amazon (from the public address), or null while none is set. */
  endpoint: string | null;
  /** The files to paste into the Alexa console (their names), for the chosen languages. */
  files: string[];
  waiting: ReturnType<AlexaDevices["waiting"]>;
  allowed: ReturnType<AlexaDevices["allowed"]>;
}

/** What Alexa gets for an open question: it is a spoken answer, so short and plain. */
const SPOKEN_NOTE = "[This was spoken through an Alexa speaker. Answer in one to three short plain sentences, with no lists, tables or markup.]";

/** Downloads Amazon's signing certificate chain (small, from a fixed host the verifier has already checked). */
export async function fetchAmazonCert(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(5000), redirect: "error" });
  if (!res.ok) throw new Error(`certificate download failed (${res.status})`);
  const text = await res.text();
  if (text.length > 20_000) throw new Error("certificate download too large");
  return text;
}

const respond = (r: AlexaReply) => ({
  version: "1.0",
  response: {
    ...(r.speech ? { outputSpeech: { type: "PlainText", text: r.speech } } : {}),
    ...(r.reprompt && !r.end ? { reprompt: { outputSpeech: { type: "PlainText", text: r.reprompt } } } : {}),
    shouldEndSession: r.end,
  },
});

/**
 * Receives what Alexa sends to Friend. It refuses anything that is not really from Amazon, for this skill and from an Echo the
 * owner has allowed; the rest is answered by the engine, with open questions going to the assistant as a voice from a speaker.
 */
export class AlexaHub {
  readonly devices: AlexaDevices;
  private engine: AlexaEngine;
  private permission: VoicePermission;

  constructor(private d: AlexaHubDeps) {
    this.devices = new AlexaDevices(d.store, d.clock);
    this.permission = new VoicePermission({
      waitMs: () => d.config.alexa.permissionSeconds * 1000,
      send: async (channel, to, text) => {
        const r = await d.channels.send(channel, to, text);
        return { ok: r.ok };
      },
      linked: d.linked,
      screenOpen: d.screenOpen,
    });
    this.engine = new AlexaEngine({
      ask: (t, l, k) => this.ask(t, l, k),
      fast: d.fast,
      clock: d.clock,
      budgetMs: () => d.config.alexa.answerSeconds * 1000,
      holdMs: () => d.config.alexa.holdMinutes * 60_000,
    });
  }

  endpoint(): string | null {
    const base = this.d.publicBase();
    return base ? `${base.replace(/\/+$/, "")}/api/alexa` : null;
  }

  status(): AlexaStatus {
    const a = this.d.config.alexa;
    return { installed: a.installed, enabled: a.enabled, skillIdSet: !!a.skillId, invocationName: a.invocationName, endpoint: this.endpoint(), files: packageFileNames(a.locales), waiting: this.devices.waiting(), allowed: this.devices.allowed() };
  }

  /** The owner's reply on Telegram or WhatsApp. True when it answered a permission request from Alexa. */
  tryApprove(text: string): boolean {
    return this.permission.tryReply(text);
  }

  async handle(rawBody: Buffer, headers: VerifyOptions["headers"]): Promise<{ status: number; body: unknown }> {
    const a = this.d.config.alexa;
    if (!a.installed || !a.enabled || !a.skillId) return { status: 400, body: { error: "Alexa is not set up." } };

    const v = await verifyAlexaRequest({ headers, rawBody, now: this.d.clock(), fetchCert: this.d.verify.fetchCert, roots: this.d.verify.roots });
    if (!v.ok) {
      this.d.audit.log("anonymous", "alexa.refused", { why: "verification" });
      return { status: 400, body: { error: "Bad request" } };
    }
    const body = v.body;
    const sys = body.context?.System;
    const application = sys?.application?.applicationId ?? body.session?.application?.applicationId;
    if (application !== a.skillId) {
      this.d.audit.log("anonymous", "alexa.refused", { why: "another skill" });
      return { status: 400, body: { error: "Bad request" } };
    }

    const userId = sys?.user?.userId ?? body.session?.user?.userId ?? "";
    const deviceId = sys?.device?.deviceId ?? "";
    const locale = body.request.locale ?? "en-IN";
    const lang = langOf(locale);
    if (!this.devices.isAllowed(userId)) {
      this.devices.noteWaiting(userId, deviceId, locale);
      this.d.audit.log("anonymous", "alexa.unknown_echo", { device: deviceId.slice(-4) });
      return { status: 200, body: respond(body.request.type === "SessionEndedRequest" ? { speech: "", end: true } : { speech: say(lang, "notAllowed"), end: true }) };
    }

    this.d.audit.log("owner", "alexa.request", { intent: body.request.intent?.name ?? body.request.type, device: deviceId.slice(-4) });
    const reply = await this.engine.handle(body, deviceId || userId, this.progressive(body));
    return { status: 200, body: respond(reply) };
  }

  /** "Let me check" spoken while the answer is being made, through Amazon's progressive response service (free). */
  private progressive(body: AlexaRequestBody): (speech: string) => void {
    const sys = body.context?.System;
    const requestId = body.request.requestId;
    return (speech) => {
      if (!sys?.apiEndpoint || !sys.apiAccessToken || !requestId) return;
      let host: URL;
      try {
        host = new URL(sys.apiEndpoint);
      } catch {
        return;
      }
      if (host.protocol !== "https:" || !(host.hostname === "amazonalexa.com" || host.hostname.endsWith(".amazonalexa.com"))) return;
      void fetch(`${host.origin}/v1/directives`, {
        method: "POST",
        headers: { authorization: `Bearer ${sys.apiAccessToken}`, "content-type": "application/json" },
        body: JSON.stringify({ header: { requestId }, directive: { type: "VoicePlayer.Speak", speech } }),
        signal: AbortSignal.timeout(3000),
      }).catch(() => {});
    };
  }

  private async ask(text: string, locale: string, _deviceKey: string): Promise<string> {
    const lang = langOf(locale);
    if (this.d.agent.isBusy()) return say(lang, "busy");
    let reply = "";
    const show = (m: ServerMsg) => {
      if (m.type === "caption.delta") reply += m.text;
      else if (m.type === "caption.end") reply += "\n";
      if (this.d.screenOpen()) this.d.broadcast(m);
    };
    if (this.d.screenOpen()) this.d.broadcast({ type: "chat.user", text } as ServerMsg);
    const emit = this.permission.wrapEmit(show, (id, approve) => this.d.respondApproval(id, approve));
    await this.d.agent.runTurn(`${SPOKEN_NOTE} ${text}`, { trust: "voice-device", emit, ip: "alexa" });
    return reply.trim() || say(lang, "failed");
  }
}
