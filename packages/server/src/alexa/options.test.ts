import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../app";
import { loadConfig, sanitizeAlexa, type AlexaConfig } from "../config";
import { openDb } from "../db";
import { FakeProvider } from "../provider/fake";
import { PolicyEngine } from "../policy/engine";
import { applySettings, settingsView } from "../settings";
import { AlexaDevices } from "./devices";
import { AlexaEngine } from "./engine";
import { buildSkillPackage, packageFileNames } from "./package";
import { VoicePermission } from "./permission";
import { testAlexaSigner } from "./testing/signer";
import type { AlexaRequestBody } from "./verify";

const fresh = () => {
  const dir = mkdtempSync(join(tmpdir(), "friend-alexaopts-"));
  return { dir, config: loadConfig(dir) };
};
const SKILL = "amzn1.ask.skill.46844077-2dc4-4bb2-8c76-60c103ab0076";

describe("the defaults are today's behaviour", () => {
  it("both languages, 6.5 s, 10 minutes, 2 minutes, 60 a minute, 10 Echos, no extra tools", () => {
    expect(fresh().config.alexa).toMatchObject({ skillName: "Friend Assistant", locales: ["en-IN", "hi-IN"], answerSeconds: 6.5, holdMinutes: 10, permissionSeconds: 120, requestsPerMinute: 60, maxDevices: 10, extraVoiceTools: [] });
  });
});

describe("what is read back from the saved file", () => {
  it("keeps every value inside its range, falls back for nonsense, and drops tools a voice may never use", () => {
    const a = sanitizeAlexa({ skillName: "x".repeat(80), locales: ["fr-FR", "hi-IN", "hi-IN"], answerSeconds: 30, holdMinutes: 0, permissionSeconds: 5, requestsPerMinute: 9999, maxDevices: 0, extraVoiceTools: ["calendar.list", "shell.run", "fs.read", "Bad Name", 5, "calendar.list"] });
    expect(a).toMatchObject({ locales: ["hi-IN"], answerSeconds: 7.5, holdMinutes: 1, permissionSeconds: 30, requestsPerMinute: 600, maxDevices: 1, extraVoiceTools: ["calendar.list"] });
    expect(a.skillName.length).toBeLessThanOrEqual(50);
    expect(sanitizeAlexa({ locales: [] }).locales).toEqual(["en-IN", "hi-IN"]);
    expect(sanitizeAlexa({ answerSeconds: "soon" }).answerSeconds).toBe(6.5);
  });
});

describe("changing them from the screen", () => {
  const patch = { alexa: { skillName: "Home Helper", locales: ["en-IN"], answerSeconds: 5, holdMinutes: 20, permissionSeconds: 180, requestsPerMinute: 30, maxDevices: 4, extraVoiceTools: ["calendar.list"] } };

  it("saves them and shows them back", () => {
    const { config } = fresh();
    const applied = applySettings(config, patch);
    expect(config.alexa).toMatchObject(patch.alexa);
    expect(applied.changed).toEqual(expect.arrayContaining(["alexa.skillName", "alexa.answerSeconds", "alexa.extraVoiceTools"]));
    expect(settingsView(config).alexa).toMatchObject(patch.alexa);
  });

  it("refuses a value outside its range, an unknown language, and a tool no voice may use, changing nothing", () => {
    const { config } = fresh();
    for (const bad of [{ answerSeconds: 8 }, { answerSeconds: 1 }, { holdMinutes: 61 }, { permissionSeconds: 10 }, { requestsPerMinute: 5 }, { maxDevices: 51 }, { locales: ["fr-FR"] }, { locales: [] }, { extraVoiceTools: ["shell.run"] }, { extraVoiceTools: ["connectors.add"] }, { extraVoiceTools: ["Not A Tool"] }]) {
      expect(() => applySettings(config, { alexa: { ...patch.alexa, ...bad } }), JSON.stringify(bad)).toThrow();
    }
    expect(config.alexa.skillName).toBe("Friend Assistant");
  });
});

const intent = (name: string, q: string): AlexaRequestBody => ({ version: "1.0", request: { type: "IntentRequest", timestamp: new Date().toISOString(), locale: "en-IN", intent: { name, slots: { q: { value: q } } } } });

describe("the engine reads its times from the settings as they are now", () => {
  it("a changed answer time and hold time apply without a restart", async () => {
    let budget = 20;
    let hold = 600_000;
    let now = 0;
    let finish!: (s: string) => void;
    const slow = new Promise<string>((r) => (finish = r));
    const engine = new AlexaEngine({ ask: () => slow, fast: {}, clock: () => now, budgetMs: () => budget, holdMs: () => hold });
    const first = await engine.handle(intent("HowIntent", "slow"), "d1");
    expect(first.speech).toMatch(/still working/i);
    finish("Done.");
    await slow;
    await Promise.resolve();
    hold = 1000;
    now = 2000;
    expect((await engine.handle({ version: "1.0", request: { type: "IntentRequest", timestamp: "", locale: "en-IN", intent: { name: "ReadyIntent" } } }, "d1")).speech).toMatch(/nothing/i);
    budget = 50;
    const quick = new AlexaEngine({ ask: async () => "Fast.", fast: {}, clock: () => now, budgetMs: () => budget });
    expect((await quick.handle(intent("HowIntent", "x"), "d2")).speech).toBe("Fast.");
  });
});

describe("permission by message reads its wait from the settings", () => {
  const card = { type: "approval.request", id: "a1", tool: "message.send", summary: "Send a message", tier: "T2", needsPin: false } as ServerMsg;
  afterEach(() => vi.useRealTimers());

  it("says how long the owner has, from the setting", async () => {
    const send = vi.fn(async (_channel: string, _to: string, _text: string) => ({ ok: true }));
    const p = new VoicePermission({ send: send as never, linked: () => ["telegram"], screenOpen: () => false, waitMs: () => 300_000 });
    p.wrapEmit(() => {}, () => {})(card);
    await new Promise((r) => setTimeout(r, 5));
    expect(send.mock.calls[0]![2]).toMatch(/within 5 minutes/);
    p.tryReply("no");
  });
});

describe("the Echo list size", () => {
  it("is the owner's number", () => {
    const cfg: AlexaConfig = { installed: true, enabled: true, skillId: "", invocationName: "", skillName: "x", locales: ["en-IN"], answerSeconds: 6.5, holdMinutes: 10, permissionSeconds: 120, requestsPerMinute: 60, maxDevices: 2, extraVoiceTools: [], allowedUsers: [] };
    const d = new AlexaDevices({ config: () => cfg, update: (fn) => fn(cfg) }, () => 1);
    const user = (n: number) => `amzn1.ask.account.AHUSERABCDEFGHIJKLMNOP${String(n).padStart(8, "0")}`;
    for (let i = 0; i < 3; i++) d.noteWaiting(user(i), "dev", "en-IN");
    expect(d.allow(user(0).slice(-8), "A")).toBe(true);
    expect(d.allow(user(1).slice(-8), "B")).toBe(true);
    expect(d.allow(user(2).slice(-8), "C")).toBe(false);
    cfg.maxDevices = 3;
    expect(d.allow(user(2).slice(-8), "C")).toBe(true);
  });
});

describe("the tools a voice may use", () => {
  const decide = (tool: string, tier: "T0" | "T1" | "T2" | "T3", extra: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "friend-voicetools-"));
    const config = loadConfig(dir);
    config.alexa.extraVoiceTools = extra;
    return new PolicyEngine(openDb(dir), config).decide({ tool, baseTier: tier, args: {}, trust: "voice-device", insideRoots: true });
  };

  it("an extra tool the owner added goes ahead, and without it asks or is refused as before", () => {
    expect(decide("calendar.list", "T2", [])).toBe("ask");
    expect(decide("calendar.list", "T2", ["calendar.list"])).toBe("allow");
    expect(decide("calendar.list", "T0", ["calendar.list"])).toBe("allow");
  });

  it("never lets a PIN tool or a PC tool through, even if it was added by hand to the file", () => {
    expect(decide("reports.schedule", "T3", ["reports.schedule"])).toBe("deny");
    expect(decide("shell.run", "T2", ["shell.run"])).toBe("deny");
    expect(decide("fs.write", "T1", ["fs.write"])).toBe("deny");
  });
});

describe("the skill package follows the settings", () => {
  const base = { invocationName: "maya", endpoint: "https://friend.example.com/api/alexa" };

  it("uses the owner's skill name and only the chosen languages", () => {
    const files = buildSkillPackage({ ...base, skillName: "Home Helper", locales: ["en-IN"] });
    expect(Object.keys(files).sort()).toEqual(["en-IN.json", "skill.json"]);
    const m = JSON.parse(files["skill.json"]!).manifest;
    expect(Object.keys(m.publishingInformation.locales)).toEqual(["en-IN"]);
    expect(m.publishingInformation.locales["en-IN"].name).toBe("Home Helper");
  });

  it("is both languages and the usual name by default, and lists its files", () => {
    expect(Object.keys(buildSkillPackage(base)).sort()).toEqual(["en-IN.json", "hi-IN.json", "skill.json"]);
    expect(packageFileNames(["hi-IN"])).toEqual(["skill.json", "hi-IN.json"]);
  });
});

describe("the endpoint's rate limit follows the setting", () => {
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  it("changes without a restart", async () => {
    const signer = await testAlexaSigner();
    const dir = mkdtempSync(join(tmpdir(), "friend-alexalimit-"));
    app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [] }, pluginCatalogDir: join(dir, "none"), alexaFetchCert: async () => signer.chainPem, alexaRoots: [signer.rootPem] });
    const { port } = await app.start();
    const base = `http://127.0.0.1:${port}`;
    const j = { "content-type": "application/json" };
    const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
    await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...(init.body ? j : {}), cookie } });
    await api("/api/plugins/install", { method: "POST", body: JSON.stringify({ id: "alexa", pin: owner.pin }) });
    const put = await api("/api/settings", { method: "PUT", body: JSON.stringify({ pin: owner.pin, settings: { alexa: { skillId: SKILL, invocationName: "maya", requestsPerMinute: 10 } } }) });
    expect(put.status).toBe(200);
    await api("/api/plugins/alexa/enabled", { method: "POST", body: JSON.stringify({ enabled: true, pin: owner.pin }) });
    const bad = () => fetch(`${base}/api/alexa`, { method: "POST", headers: { ...j, signaturecertchainurl: "https://s3.amazonaws.com/echo.api/c.pem", "signature-256": "AAAA" }, body: "{}" });
    for (let i = 0; i < 10; i++) expect((await bad()).status).toBe(400);
    expect((await bad()).status).toBe(429);
  });
});
