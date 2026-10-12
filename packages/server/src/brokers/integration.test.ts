import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig, type Config } from "../config";
import { changeBroker, integrationSummary, integrationViews, isIntegrationId, PUBLIC_SETTINGS } from "../integrations";
import type { BrokerStatus } from "./hub";

const config = (mutate: (c: Config) => void = () => {}): Config => {
  const c = loadConfig(mkdtempSync(join(tmpdir(), "friend-brokerint-")));
  mutate(c);
  return c;
};
const channels = { status: () => ({ telegram: { enabled: false, tokenSet: false, linked: false, state: "off" as const, detail: "", bot: null }, twilio: { enabled: false, tokenSet: false, ownerSet: false, sms: false, whatsapp: false, webhook: null } }) };
const brokers = (over: Partial<BrokerStatus> = {}) => ({ status: (): BrokerStatus => ({ installed: true, enabled: true, keySet: true, secretSet: true, loggedIn: false, expiresAt: null, detail: "", ...over }) });
const zerodha = (c: Config, b?: ReturnType<typeof brokers>) => integrationViews(c, channels, b).find((v) => v.id === "zerodha")!;

describe("Zerodha in the plugins list", () => {
  it("is the third integration (Alexa follows) and starts not installed", () => {
    const views = integrationViews(config(), channels);
    expect(views.map((v) => v.id)).toEqual(["telegram", "twilio", "zerodha", "alexa", "spotify", "soundcloud", "audius", "chrome", "video"]);
    expect(views[2]).toMatchObject({ name: "Zerodha", kind: "integration", installed: false, enabled: false, state: "not-installed" });
    expect(views[2]!.steps).toHaveLength(4);
    expect(isIntegrationId("zerodha")).toBe(true);
  });

  it("asks for the key and secret, then for switching on, then for the daily login", () => {
    const c = config((x) => (x.brokers.zerodha.installed = true));
    expect(zerodha(c)).toMatchObject({ state: "needs-setup", detail: expect.stringMatching(/Kite API key and secret/) });
    c.brokers.zerodha.apiKey = "abc123";
    c.brokers.zerodha.apiSecret = "SECRET123";
    expect(zerodha(c)).toMatchObject({ state: "off" });
    c.brokers.zerodha.enabled = true;
    expect(zerodha(c, brokers())).toMatchObject({ state: "needs-setup", detail: expect.stringMatching(/Log in to Zerodha \(press Configure\)/) });
    const online = zerodha(c, brokers({ loggedIn: true, expiresAt: Date.now() + 3600_000 }));
    expect(online).toMatchObject({ state: "online", enabled: true, detail: expect.stringMatching(/Logged in until 06:00 tomorrow/) });
    expect(online.steps.map((s) => s.done)).toEqual([true, true, true, true]);
  });

  it("never carries the secret or a token, only whether they exist", () => {
    const c = config((x) => (x.brokers.zerodha = { installed: true, enabled: true, apiKey: "abc123", apiSecret: "SECRET123" }));
    const all = JSON.stringify(integrationViews(c, channels, brokers({ loggedIn: true, expiresAt: Date.now() + 1000 })));
    expect(all).not.toContain("SECRET123");
    expect(zerodha(c, brokers()).secrets).toEqual({ apiSecret: true });
  });

  it("is named in the assistant's summary line", () => {
    expect(integrationSummary(integrationViews(config(), channels))).toContain("Zerodha (zerodha): not installed");
  });

  it("has no setting the assistant may change", () => {
    expect(PUBLIC_SETTINGS.zerodha).toEqual([]);
  });
});

describe("installing, switching on and removing", () => {
  it("installs, and refuses to switch on without a key and secret", () => {
    const c = config();
    expect(changeBroker(c.brokers, "zerodha", { enabled: true })).toMatch(/not installed yet/);
    expect(changeBroker(c.brokers, "zerodha", { install: true })).toBeNull();
    expect(c.brokers.zerodha.installed).toBe(true);
    expect(changeBroker(c.brokers, "zerodha", { enabled: true })).toMatch(/Add the Kite API key and secret first/);
    c.brokers.zerodha.apiKey = "abc123";
    expect(changeBroker(c.brokers, "zerodha", { enabled: true })).toMatch(/Add the Kite API key and secret first/);
    c.brokers.zerodha.apiSecret = "S";
    expect(changeBroker(c.brokers, "zerodha", { enabled: true })).toBeNull();
    expect(c.brokers.zerodha.enabled).toBe(true);
    expect(changeBroker(c.brokers, "zerodha", { enabled: false })).toBeNull();
    expect(c.brokers.zerodha.enabled).toBe(false);
  });

  it("removing forgets the key and secret, keeps the owner's other broker settings, and calls onRemove", () => {
    const c = config((x) => {
      x.brokers.zerodha = { installed: true, enabled: true, apiKey: "abc123", apiSecret: "S" };
      x.brokers.timezone = "Europe/London";
      x.brokers.skipDates = ["2026-11-08"];
    });
    const removed: string[] = [];
    expect(changeBroker(c.brokers, "zerodha", { remove: true }, (id) => removed.push(id))).toBeNull();
    expect(c.brokers.zerodha).toEqual({ installed: false, enabled: false, apiKey: "", apiSecret: null });
    expect(c.brokers).toMatchObject({ timezone: "Europe/London", skipDates: ["2026-11-08"] });
    expect(removed).toEqual(["zerodha"]);
  });
});
