import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Audit } from "../audit";
import { loadConfig, type Config } from "../config";
import { openDb } from "../db";
import { AlexaHub } from "./hub";
import { testAlexaSigner, type TestSigner } from "./testing/signer";

const SKILL = "amzn1.ask.skill.46844077-2dc4-4bb2-8c76-60c103ab0076";
const USER = "amzn1.ask.account.AHUSERABCDEFGHIJKLMNOP00000001";
const OTHER = "amzn1.ask.account.AHUSERABCDEFGHIJKLMNOP00000002";
const CERT = "https://s3.amazonaws.com/echo.api/echo-api-cert-7.pem";

let signer: TestSigner;
let config: Config;
let audit: Audit;
let db: ReturnType<typeof openDb>;
let screen: boolean;
let busy: boolean;
let linked: ("telegram" | "whatsapp")[];
let runTurn: ReturnType<typeof vi.fn>;
let respond: ReturnType<typeof vi.fn>;
let send: ReturnType<typeof vi.fn>;
let broadcast: ReturnType<typeof vi.fn>;
let hub: AlexaHub;

const request = (over: { intent?: string; slots?: Record<string, string>; type?: string; user?: string; app?: string; locale?: string } = {}) =>
  Buffer.from(
    JSON.stringify({
      version: "1.0",
      session: { new: true, sessionId: "s1", application: { applicationId: over.app ?? SKILL }, user: { userId: over.user ?? USER } },
      context: { System: { application: { applicationId: over.app ?? SKILL }, user: { userId: over.user ?? USER }, device: { deviceId: "amzn1.ask.device.KITCHEN0001" } } },
      request: {
        type: over.type ?? (over.intent ? "IntentRequest" : "LaunchRequest"),
        requestId: "r1",
        timestamp: new Date().toISOString(),
        locale: over.locale ?? "en-IN",
        ...(over.intent ? { intent: { name: over.intent, slots: Object.fromEntries(Object.entries(over.slots ?? {}).map(([k, v]) => [k, { value: v }])) } } : {}),
      },
    }),
  );
const call = (raw: Buffer, headers: Record<string, string> = {}) => hub.handle(raw, { signaturecertchainurl: CERT, "signature-256": signer.sign(raw), ...headers });
const speech = (out: { body: unknown }) => ((out.body as { response?: { outputSpeech?: { text?: string } } }).response?.outputSpeech?.text ?? "");
const rows = () => db.prepare("select kind, detail_json d from audit_log where kind like 'alexa.%'").all() as { kind: string; d: string }[];

beforeEach(async () => {
  signer = await testAlexaSigner();
  const dir = mkdtempSync(join(tmpdir(), "friend-alexahub-"));
  db = openDb(dir);
  audit = new Audit(db);
  config = loadConfig(dir);
  config.alexa = { installed: true, enabled: true, skillId: SKILL, invocationName: "jarvis assistant", allowedUsers: [{ id: USER, name: "Kitchen", addedAt: 1 }] };
  screen = false;
  busy = false;
  linked = [];
  runTurn = vi.fn(async (_t: string, ctx: { emit: (m: ServerMsg) => void }) => {
    ctx.emit({ type: "caption.delta", text: "Your portfolio is fine." } as ServerMsg);
    ctx.emit({ type: "caption.end" } as ServerMsg);
  });
  respond = vi.fn();
  send = vi.fn(async () => ({ ok: true, summary: "sent" }));
  broadcast = vi.fn();
  hub = new AlexaHub({
    config,
    store: { config: () => config.alexa, update: (fn) => fn(config.alexa) },
    verify: { fetchCert: async () => signer.chainPem, roots: [signer.rootPem] },
    clock: Date.now,
    agent: { isBusy: () => busy, runTurn: runTurn as never },
    broadcast: broadcast as never,
    screenOpen: () => screen,
    fast: { PortfolioIntent: async () => "Your portfolio is up one percent." },
    channels: { send: send as never },
    linked: () => linked,
    respondApproval: respond as never,
    audit,
    publicBase: () => "https://friend.example.com",
  });
});

describe("what is refused", () => {
  it("a request that is not signed by Amazon", async () => {
    const out = await call(request({ intent: "HowIntent", slots: { q: "it is" } }), { "signature-256": "AAAA" });
    expect(out.status).toBe(400);
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("a request meant for another skill, and nothing is answered", async () => {
    const out = await call(request({ intent: "HowIntent", slots: { q: "it is" }, app: "amzn1.ask.skill.00000000-0000-0000-0000-000000000000" }));
    expect(out.status).toBe(400);
    expect(runTurn).not.toHaveBeenCalled();
    expect(rows().some((r) => r.kind === "alexa.refused")).toBe(true);
  });

  it("everything while the plugin is off or has no skill id", async () => {
    config.alexa.enabled = false;
    expect((await call(request({ intent: "PortfolioIntent" }))).status).toBe(400);
    config.alexa.enabled = true;
    config.alexa.skillId = "";
    expect((await call(request({ intent: "PortfolioIntent" }))).status).toBe(400);
  });
});

describe("an Echo that is not allowed yet", () => {
  it("gets a fixed answer, is listed once as waiting, and the assistant is never asked", async () => {
    const a = await call(request({ intent: "HowIntent", slots: { q: "my portfolio is" }, user: OTHER }));
    const b = await call(request({ intent: "HowIntent", slots: { q: "my portfolio is" }, user: OTHER }));
    expect(a.status).toBe(200);
    expect(speech(a)).toMatch(/do not know this Echo/i);
    expect((a.body as { response: { shouldEndSession: boolean } }).response.shouldEndSession).toBe(true);
    expect(speech(b)).toBe(speech(a));
    expect(hub.status().waiting).toHaveLength(1);
    expect(runTurn).not.toHaveBeenCalled();
    expect(JSON.stringify(hub.status())).not.toContain(OTHER);
  });

  it("is told in Hindi when it speaks Hindi, and a session end says nothing", async () => {
    const hi = await call(request({ intent: "HowIntent", slots: { q: "x" }, user: OTHER, locale: "hi-IN" }));
    expect(speech(hi)).toMatch(/[ऀ-ॿ]/);
    const end = await call(request({ type: "SessionEndedRequest", user: OTHER }));
    expect(speech(end)).toBe("");
  });

  it("after the owner allows it, is answered", async () => {
    await call(request({ intent: "HowIntent", slots: { q: "it is" }, user: OTHER }));
    expect(hub.devices.allow(OTHER.slice(-8), "Bedroom")).toBe(true);
    const out = await call(request({ intent: "HowIntent", slots: { q: "my portfolio is" }, user: OTHER }));
    expect(speech(out)).toBe("Your portfolio is fine.");
  });
});

describe("an Echo that is allowed", () => {
  it("is greeted when it opens the skill", async () => {
    const out = await call(request());
    expect(out.status).toBe(200);
    expect((out.body as { version: string }).version).toBe("1.0");
    expect(speech(out)).toMatch(/Friend here/i);
  });

  it("gets fixed questions from the tools, with no assistant", async () => {
    const out = await call(request({ intent: "PortfolioIntent" }));
    expect(speech(out)).toBe("Your portfolio is up one percent.");
    expect(runTurn).not.toHaveBeenCalled();
  });

  it("has open questions answered by the assistant as a voice from a speaker, in a short form", async () => {
    const out = await call(request({ intent: "HowIntent", slots: { q: "my portfolio is doing" } }));
    expect(speech(out)).toBe("Your portfolio is fine.");
    expect(runTurn).toHaveBeenCalledTimes(1);
    const [text, ctx] = runTurn.mock.calls[0]!;
    expect(text).toContain("how my portfolio is doing");
    expect(text).toMatch(/short/i);
    expect(ctx).toMatchObject({ trust: "voice-device" });
  });

  it("shows the conversation on the screen only when a screen is open", async () => {
    await call(request({ intent: "HowIntent", slots: { q: "it is" } }));
    expect(broadcast).not.toHaveBeenCalled();
    screen = true;
    await call(request({ intent: "HowIntent", slots: { q: "it is" } }));
    expect(broadcast).toHaveBeenCalled();
  });

  it("is told briefly when the assistant is busy", async () => {
    busy = true;
    const out = await call(request({ intent: "HowIntent", slots: { q: "it is" } }));
    expect(speech(out)).toMatch(/busy/i);
    expect(runTurn).not.toHaveBeenCalled();
  });
});

describe("permission and what is recorded", () => {
  it("a Telegram or WhatsApp yes is passed on, and anything else is not", async () => {
    linked = ["telegram"];
    runTurn.mockImplementationOnce(async (_t: string, ctx: { emit: (m: ServerMsg) => void }) => {
      ctx.emit({ type: "approval.request", id: "ap1", tool: "message.send", summary: "Send a message", tier: "T2", needsPin: false } as ServerMsg);
      await new Promise((r) => setTimeout(r, 30));
      ctx.emit({ type: "caption.delta", text: "Done." } as ServerMsg);
    });
    const pending = call(request({ intent: "TellMeIntent", slots: { q: "to send Anu a message" } }));
    await vi.waitFor(() => expect(send).toHaveBeenCalled());
    expect(hub.tryApprove("how is my portfolio")).toBe(false);
    expect(hub.tryApprove("yes")).toBe(true);
    expect(respond).toHaveBeenCalledWith("ap1", true);
    expect(speech(await pending)).toBe("Done.");
  });

  it("records the intent and the Echo, but never what was said", async () => {
    await call(request({ intent: "HowIntent", slots: { q: "my secret bank thing" } }));
    const all = JSON.stringify(rows());
    expect(all).toContain("HowIntent");
    expect(all).not.toMatch(/secret bank thing/);
    expect(all).not.toContain(USER);
    expect(all).not.toContain("KITCHEN0001");
  });
});

describe("the address to give Amazon", () => {
  it("comes from the public address, and is empty without one", () => {
    expect(hub.endpoint()).toBe("https://friend.example.com/api/alexa");
    const bare = new AlexaHub({ config, store: { config: () => config.alexa, update: () => {} }, verify: { fetchCert: async () => "", roots: [] }, clock: Date.now, agent: { isBusy: () => false, runTurn: async () => {} }, broadcast: () => {}, screenOpen: () => false, fast: {}, channels: { send: async () => ({ ok: true, summary: "" }) }, linked: () => [], respondApproval: () => {}, audit, publicBase: () => null });
    expect(bare.endpoint()).toBeNull();
  });
});
