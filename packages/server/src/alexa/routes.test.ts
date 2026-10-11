import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../app";
import { loadConfig } from "../config";
import { FakeProvider } from "../provider/fake";
import { testAlexaSigner, type TestSigner } from "./testing/signer";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const SKILL = "amzn1.ask.skill.46844077-2dc4-4bb2-8c76-60c103ab0076";
const USER = "amzn1.ask.account.AHUSERABCDEFGHIJKLMNOP00000001";
const CERT = "https://s3.amazonaws.com/echo.api/echo-api-cert-7.pem";
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function boot(setup = true, publicUrl?: string) {
  const signer: TestSigner = await testAlexaSigner();
  const dir = mkdtempSync(join(tmpdir(), "friend-alexaapi-"));
  app = await createApp({
    dataDir: dir,
    provider: new FakeProvider(Array.from({ length: 6 }, () => [{ type: "text_delta", text: "Your portfolio is fine." }, { type: "done" }]) as never),
    config: { port: 0, roots: [], ...(publicUrl ? { publicUrl } : {}) },
    pluginCatalogDir: join(dir, "no-catalog"),
    alexaFetchCert: async () => signer.chainPem,
    alexaRoots: [signer.rootPem],
  });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const j = { "content-type": "application/json" };
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const api = (path: string, init: RequestInit = {}) => fetch(base + path, { ...init, headers: { ...(init.body ? j : {}), cookie } });
  const json = async (path: string, init?: RequestInit) => (await api(path, init)).json() as Promise<Record<string, any>>;
  if (setup) {
    await api("/api/plugins/install", { method: "POST", body: JSON.stringify({ id: "alexa", pin: owner.pin }) });
    await api("/api/settings", { method: "PUT", body: JSON.stringify({ pin: owner.pin, settings: { alexa: { skillId: SKILL, invocationName: "jarvis assistant" } } }) });
    await api("/api/plugins/alexa/enabled", { method: "POST", body: JSON.stringify({ enabled: true, pin: owner.pin }) });
  }
  const alexa = (raw: string, headers: Record<string, string> = {}) =>
    fetch(`${base}/api/alexa`, { method: "POST", headers: { "content-type": "application/json", signaturecertchainurl: CERT, "signature-256": signer.sign(raw), ...headers }, body: raw });
  const body = (over: { user?: string; app?: string; intent?: string; q?: string } = {}) =>
    JSON.stringify({
      version: "1.0",
      session: { new: true, application: { applicationId: over.app ?? SKILL }, user: { userId: over.user ?? USER } },
      context: { System: { application: { applicationId: over.app ?? SKILL }, user: { userId: over.user ?? USER }, device: { deviceId: "amzn1.ask.device.KITCHEN0001" } } },
      request: { type: "IntentRequest", requestId: "r1", timestamp: new Date().toISOString(), locale: "en-IN", intent: { name: over.intent ?? "HowIntent", slots: { q: { value: over.q ?? "my portfolio is" } } } },
    });
  return { dir, api, json, alexa, body, signer };
}
const said = async (res: Response) => ((await res.json()) as { response: { outputSpeech?: { text: string } } }).response.outputSpeech?.text ?? "";

describe("the endpoint Amazon calls", () => {
  it("refuses a request that is not signed, and one meant for another skill", async () => {
    const t = await boot();
    expect((await t.alexa(t.body(), { "signature-256": "AAAA" })).status).toBe(400);
    expect((await t.alexa(t.body({ app: "amzn1.ask.skill.00000000-0000-0000-0000-000000000000" }))).status).toBe(400);
  });

  it("answers an unknown Echo with a fixed sentence, lists it as waiting, and answers it once the owner allows it", async () => {
    const t = await boot();
    const first = await t.alexa(t.body());
    expect(first.status).toBe(200);
    expect(await said(first)).toMatch(/do not know this Echo/i);

    const status = await t.json("/api/alexa");
    expect(status.waiting).toHaveLength(1);
    expect(JSON.stringify(status)).not.toContain(USER);
    const short = (status.waiting as { short: string }[])[0]!.short;

    const allow = (pin: string) => t.api("/api/alexa/devices/allow", { method: "POST", body: JSON.stringify({ id: short, name: "Kitchen", pin }) });
    expect((await allow("000000")).status).toBe(403);
    expect((await allow(owner.pin)).status).toBe(200);
    expect(loadConfig(t.dir).alexa.allowedUsers).toHaveLength(1);

    expect(await said(await t.alexa(t.body()))).toBe("Your portfolio is fine.");
    expect((await t.json("/api/alexa")).allowed).toEqual([{ short, name: "Kitchen", addedAt: expect.any(Number) }]);

    expect((await t.api(`/api/alexa/devices/${short}`, { method: "DELETE" })).status).toBe(200);
    expect(loadConfig(t.dir).alexa.allowedUsers).toHaveLength(0);
  });

  it("answers nothing while the plugin is not set up", async () => {
    const t = await boot(false);
    expect((await t.alexa(t.body())).status).toBe(400);
  });

  it("refuses a body over 32 KB", async () => {
    const t = await boot();
    const big = JSON.stringify({ pad: "x".repeat(40_000) });
    expect((await t.alexa(big)).status).toBe(413);
  });

  it("allows 60 requests a minute from one address, then says 429", async () => {
    const t = await boot();
    for (let i = 0; i < 60; i++) expect((await t.alexa(t.body(), { "signature-256": "AAAA" })).status).toBe(400);
    expect((await t.alexa(t.body(), { "signature-256": "AAAA" })).status).toBe(429);
  });
});

describe("the owner's routes", () => {
  it("need the owner's session", async () => {
    const t = await boot();
    const res = await fetch(`${(await t.api("/api/alexa")).url}`);
    expect(res.status).toBe(401);
  });

  it("show the address to give Amazon, and the status, without the skill id's secret parts", async () => {
    const t = await boot();
    const status = await t.json("/api/alexa");
    expect(status).toMatchObject({ installed: true, enabled: true, skillIdSet: true, invocationName: "jarvis assistant" });
    expect(status.endpoint).toBeNull(); // no public address yet
    expect((await t.api("/api/alexa/package/skill.json")).status).toBe(404); // so there are no files to paste yet
  });

  it("allow needs a PIN in the body, and an Echo that is not waiting cannot be allowed", async () => {
    const t = await boot();
    expect((await t.api("/api/alexa/devices/allow", { method: "POST", body: JSON.stringify({ id: "ZZZZZZZZ", name: "x" }) })).status).toBe(400);
    expect((await t.api("/api/alexa/devices/allow", { method: "POST", body: JSON.stringify({ id: "ZZZZZZZZ", name: "x", pin: owner.pin }) })).status).toBe(404);
    expect((await t.api("/api/alexa/devices/ZZZZZZZZ", { method: "DELETE" })).status).toBe(404);
  });
});

describe("the skill files to paste into the Alexa console", () => {
  it("are served to the owner with the current public address, and nothing without one", async () => {
    const t = await boot(true, "https://friend.example.com");
    const skill = await t.api("/api/alexa/package/skill.json");
    expect(skill.status).toBe(200);
    expect(skill.headers.get("content-disposition")).toMatch(/attachment; filename="skill.json"/);
    expect(JSON.stringify(await skill.json())).toContain("https://friend.example.com/api/alexa");
    expect(((await (await t.api("/api/alexa/package/en-IN.json")).json()) as any).interactionModel.languageModel.invocationName).toBe("jarvis assistant");
    expect((await t.api("/api/alexa/package/other.json")).status).toBe(404);
    expect((await t.json("/api/alexa")).endpoint).toBe("https://friend.example.com/api/alexa");
    const anon = await fetch(`${(await t.api("/api/alexa")).url.replace("/api/alexa", "")}/api/alexa/package/skill.json`);
    expect(anon.status).toBe(401);

  });
});

describe("the plugins list", () => {
  it("offers Alexa, and removing it forgets the skill id and the allowed Echoes", async () => {
    const t = await boot();
    const plugins = (await t.json("/api/plugins")) as { integrations: { id: string; installed: boolean; state: string }[] };
    expect(plugins.integrations.map((i) => i.id)).toEqual(["telegram", "twilio", "zerodha", "alexa", "spotify", "soundcloud", "audius", "chrome"]);
    expect(plugins.integrations.find((i) => i.id === "alexa")).toMatchObject({ installed: true });
    await t.api("/api/plugins/alexa", { method: "DELETE" });
    // the skill id, the name and the allowed Echoes are forgotten; the owner's other Alexa preferences stay
    expect(loadConfig(t.dir).alexa).toMatchObject({ installed: false, enabled: false, skillId: "", invocationName: "", allowedUsers: [], skillName: "Friend Assistant" });
  });
});
