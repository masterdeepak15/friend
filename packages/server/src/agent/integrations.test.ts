import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { makeAdmin, type CatalogAdmin, type IntegrationAdmin } from "../admin";
import { Approvals } from "../approvals";
import { Audit } from "../audit";
import { Auth } from "../auth";
import { loadConfig, type Config } from "../config";
import { openDb } from "../db";
import { integrationSummary, integrationViews, type IntegrationView } from "../integrations";
import { Plugins } from "../plugins";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { StageState } from "../stage";
import { Agent } from "./loop";

const call = (id: string, name: string, args: unknown = {}): ProviderEvent => ({ type: "tool_call", id, name, args });
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };

let emitted: ServerMsg[];
let decision: "approve" | "deny";
let approvals: Approvals;
let config: Config;
let views: IntegrationView[];
let integ: { [K in keyof IntegrationAdmin]: ReturnType<typeof vi.fn<IntegrationAdmin[K]>> };
let catalog: { list: ReturnType<typeof vi.fn<CatalogAdmin["list"]>>; install: ReturnType<typeof vi.fn<CatalogAdmin["install"]>> };
let build: (provider: FakeProvider) => Agent;

const emit = (m: ServerMsg) => {
  emitted.push(m);
  if (m.type === "approval.request") void approvals.respond({ id: m.id, decision, pin: m.needsPin ? "123456" : undefined }, "9.9.9.9");
};
const ctx = { trust: "owner" as const, emit, ip: "9.9.9.9" };
const lastTool = (p: FakeProvider) => JSON.stringify(p.calls.at(-1)!.messages.at(-1));
const cards = () => emitted.filter((m) => m.type === "approval.request") as Extract<ServerMsg, { type: "approval.request" }>[];
const run = async (script: ProviderEvent[][]) => {
  const provider = new FakeProvider(script);
  await build(provider).runTurn("set up telegram", ctx);
  return provider;
};
const one = (name: string, args: unknown = {}): ProviderEvent[][] => [[call("t1", name, args), done], [text("ok"), done]];
const status = (installed: boolean, token = false): IntegrationView[] =>
  integrationViews(
    (() => {
      const c = loadConfig(mkdtempSync(join(tmpdir(), "friend-intv-")));
      c.channels.telegram.installed = installed;
      c.channels.telegram.botToken = token ? "123456789:AAEhBP0abcdefghijklmnopqrstuvwxyz1" : null;
      return c;
    })(),
    { status: () => ({ telegram: { enabled: false, tokenSet: token, linked: false, state: "off", detail: "", bot: null }, twilio: { enabled: false, tokenSet: false, ownerSet: false, sms: false, whatsapp: false, webhook: null } }) },
  );

beforeEach(async () => {
  emitted = [];
  decision = "approve";
  views = status(false);
  integ = {
    views: vi.fn<IntegrationAdmin["views"]>(() => views),
    install: vi.fn<IntegrationAdmin["install"]>(() => null),
    remove: vi.fn<IntegrationAdmin["remove"]>(() => null),
    configure: vi.fn<IntegrationAdmin["configure"]>(() => null),
  };
  catalog = {
    list: vi.fn<CatalogAdmin["list"]>(() => [{ id: "unit-converter", name: "Unit converter", version: "1.0.0", description: "Converts units", installed: false, error: null }]),
    install: vi.fn<CatalogAdmin["install"]>(() => ({ ok: true, upgraded: false })),
  };
  const dir = mkdtempSync(join(tmpdir(), "friend-aiint-"));
  const db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
  config = loadConfig(dir);
  const policy = new PolicyEngine(db, config);
  approvals = new Approvals({ auth, policy, audit, db }, 500);
  const admin = makeAdmin({ hub: {} as never, plugins: new Plugins(db, join(dir, "plugins")), dataDir: dir, audit: () => {}, integrations: integ, catalog });
  build = (provider) =>
    new Agent({
      provider,
      policy,
      approvals,
      devices: { exec: vi.fn(), hasOnline: () => true, targetName: () => "pc" } as never,
      stage: new StageState(),
      db,
      audit,
      config,
      assistantName: () => "Jarvis",
      admin,
      integrations: { summary: () => integrationSummary(integ.views()) },
    });
});

describe("the assistant looks around", () => {
  it("lists the catalog, with the built-in integrations first, without asking", async () => {
    const p = await run(one("plugins.catalog"));
    expect(cards()).toEqual([]);
    const out = lastTool(p);
    expect(out).toContain("telegram: Telegram (integration, not installed)");
    expect(out).toContain("twilio: WhatsApp and SMS (Twilio) (integration, not installed)");
    expect(out).toContain("unit-converter: Unit converter 1.0.0 (available)");
  });

  it("tells how far an integration is and what is left, as steps", async () => {
    views = status(true, false);
    const out = lastTool(await run(one("integrations.status", { id: "telegram" })));
    expect(out).toMatch(/Telegram \(telegram\): needs-setup - Add the bot token/);
    expect(out).toMatch(/\[ \] 1\. Create a bot.*@BotFather/);
    expect(out).toMatch(/secrets: botToken: not set, linked: not set/);
  });

  it("says to install first when it is not installed", async () => {
    expect(lastTool(await run(one("integrations.status", { id: "telegram" })))).toMatch(/not installed.*plugins\.install telegram/);
  });

  it("knows the state of every integration without being asked (the request context)", async () => {
    const p = await run(one("integrations.status"));
    expect(p.calls[0]!.context).toMatch(/Integrations \(plugins you can install.*Telegram \(telegram\): not installed/);
  });
});

describe("installing", () => {
  it("an integration needs the owner's PIN, then it is installed and the next step is named", async () => {
    const p = await run(one("plugins.install", { id: "telegram" }));
    expect(cards()[0]).toMatchObject({ tool: "plugins.install", tier: "T3", needsPin: true });
    expect(cards()[0]!.summary).toMatch(/Install the plugin telegram/);
    expect(integ.install).toHaveBeenCalledWith("telegram");
    expect(lastTool(p)).toMatch(/Installed telegram.*integrations\.status telegram.*integrations\.open/);
  });

  it("a catalog plugin is installed the same way", async () => {
    const p = await run(one("plugins.install", { id: "unit-converter" }));
    expect(cards()[0]).toMatchObject({ needsPin: true });
    expect(catalog.install).toHaveBeenCalledWith("unit-converter");
    expect(lastTool(p)).toMatch(/Installed the plugin unit-converter/);
  });

  it("nothing is installed when the owner says no", async () => {
    decision = "deny";
    const p = await run(one("plugins.install", { id: "telegram" }));
    expect(integ.install).not.toHaveBeenCalled();
    expect(lastTool(p)).toMatch(/did not approve/);
  });

  it("asks even in auto approval mode, because it adds a capability", async () => {
    config.approvals = "auto";
    await run(one("plugins.install", { id: "telegram" }));
    expect(cards()).toHaveLength(1);
  });

  it("reports why it could not be installed", async () => {
    catalog.install.mockReturnValueOnce({ ok: false, error: "That plugin is not in the catalog." });
    expect(lastTool(await run(one("plugins.install", { id: "nonsense" })))).toMatch(/not in the catalog/);
  });
});

describe("setting up", () => {
  it("changes the non-secret settings with the PIN", async () => {
    const p = await run(one("integrations.configure", { id: "twilio", ownerNumber: "+919800000000", smsFrom: "+14155550100", enabled: true }));
    expect(cards()[0]).toMatchObject({ tool: "integrations.configure", tier: "T3", needsPin: true });
    expect(cards()[0]!.summary).toContain("+919800000000");
    expect(integ.configure).toHaveBeenCalledWith("twilio", { enabled: true, settings: { ownerNumber: "+919800000000", smsFrom: "+14155550100" } });
    expect(lastTool(p)).toMatch(/Tokens and passwords are entered by the owner/);
  });

  it("can never be given a token or password: asking for one is an error, nothing is changed", async () => {
    const p = await run(one("integrations.configure", { id: "telegram", botToken: "123456789:AAEhBP0abcdefghijklmnopqrstuvwxyz1" }));
    expect(lastTool(p)).toMatch(/Invalid arguments/);
    expect(cards()).toEqual([]);
    expect(integ.configure).not.toHaveBeenCalled();
    const q = await run(one("integrations.configure", { id: "twilio", authToken: "secret" }));
    expect(lastTool(q)).toMatch(/Invalid arguments/);
  });

  it("refuses a setting that is not for that integration", async () => {
    expect(lastTool(await run(one("integrations.configure", { id: "telegram", ownerNumber: "+919800000000" })))).toMatch(/ownerNumber cannot be set by you for telegram/);
    expect(integ.configure).not.toHaveBeenCalled();
  });

  it("reports what the app says when a change cannot be made", async () => {
    integ.configure.mockReturnValueOnce("Add the bot token first (Configure), then switch it on.");
    expect(lastTool(await run(one("integrations.configure", { id: "telegram", enabled: true })))).toMatch(/bot token first/);
  });

  it("opens the configure page on the owner's screen, without asking", async () => {
    const p = await run(one("integrations.open", { id: "telegram" }));
    expect(cards()).toEqual([]);
    expect(emitted).toContainEqual({ type: "ui.open", panel: "plugins", integration: "telegram" });
    expect(lastTool(p)).toMatch(/plugins screen is open.*telegram/);
  });

  it("removes with the owner's approval (no PIN), and forgets the tokens", async () => {
    await run(one("integrations.remove", { id: "twilio" }));
    expect(cards()[0]).toMatchObject({ tool: "integrations.remove", tier: "T2", needsPin: false });
    expect(integ.remove).toHaveBeenCalledWith("twilio");
  });

  it("is never allowed to a guest", async () => {
    const provider = new FakeProvider(one("plugins.install", { id: "telegram" }));
    await build(provider).runTurn("install it", { ...ctx, trust: "guest" });
    expect(integ.install).not.toHaveBeenCalled();
    expect(cards()).toEqual([]);
  });
});
