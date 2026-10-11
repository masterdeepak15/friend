import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LOOK, type AlexaView, type BrokersView, type SettingsApi, type SettingsView } from "../settings/settingsApi";
import type { AlexaApi, AlexaStatus } from "./AlexaForm";
import { IntegrationConfig } from "./IntegrationConfig";
import type { IntegrationEntry } from "./pluginsApi";
import type { BrokersApi, BrokersStatus } from "./ZerodhaForm";

afterEach(cleanup);

const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const entry = (id: string): IntegrationEntry => ({ id, name: id, description: "", installed: true, enabled: true, state: "online", detail: "", steps: [] });
const alexaDefaults: AlexaView = { installed: true, enabled: true, skillId: "amzn1.ask.skill.46844077-2dc4-4bb2-8c76-60c103ab0076", invocationName: "maya", allowed: [], skillName: "Friend Assistant", locales: ["en-IN", "hi-IN"], answerSeconds: 6.5, holdMinutes: 10, permissionSeconds: 120, requestsPerMinute: 60, maxDevices: 10, extraVoiceTools: [] };
const brokerDefaults: BrokersView = { zerodha: { installed: true, enabled: true, apiKey: "abc123", secretSet: true }, timezone: "Asia/Kolkata", skipDates: [], loginReminderMinutes: 15, currencySymbol: "₹", currencyName: "rupees", numberLocale: "en-IN", concentrationPct: 30, bigDropPct: 5, cacheSeconds: 30, maxSchedules: 20, maxTriesPerDay: 3 };
const view = (): SettingsView => ({
  provider: "claude-code",
  model: "claude-sonnet-5-5",
  apiKeySet: false,
  view: "companion",
  approvals: "manual",
  look: { ...DEFAULT_LOOK },
  ollama: { url: "http://127.0.0.1:11434", model: "qwen2.5:7b", vision: false, contextTokens: 8192 },
  claudeCode: { model: "sonnet", command: "claude", fallback: "ollama" },
  voice: { enabled: true, speakTyped: true, language: null, accept: 0.72, challenge: 0.58, ttsVoice: "en_US-lessac-medium", sttModel: "base" },
  alexa: alexaDefaults,
  brokers: brokerDefaults,
});
const settings = (): SettingsApi => ({ get: vi.fn(async () => view()), save: vi.fn(async () => ({ settings: view(), changed: true, restart: [] })) });
const alexaApi = (files = ["skill.json", "en-IN.json", "hi-IN.json"]): AlexaApi => ({
  status: vi.fn(async (): Promise<AlexaStatus> => ({ installed: true, enabled: true, skillIdSet: true, invocationName: "maya", endpoint: "https://friend.example.com/api/alexa", files, waiting: [], allowed: [] })),
  allow: vi.fn(async () => {}),
  forget: vi.fn(async () => {}),
});
const brokersApi = (): BrokersApi => ({
  status: vi.fn(async (): Promise<BrokersStatus> => ({ zerodha: { installed: true, enabled: true, keySet: true, secretSet: true, loggedIn: false, expiresAt: null, detail: "Login needed" }, schedules: [], redirectUrl: null, timezone: "Asia/Kolkata" })),
  loginLink: vi.fn(async () => ({ url: "https://kite.zerodha.com/x" })),
  runNow: vi.fn(async () => ({ text: "" })),
  addSchedule: vi.fn(async () => {}),
  removeSchedule: vi.fn(async () => {}),
});
const save = async () => {
  await userEvent.click(screen.getByRole("button", { name: "Save…" }));
  await typePin("123456");
  await userEvent.click(screen.getByRole("button", { name: "Save" }));
};

describe("Alexa advanced settings", () => {
  it("shows the current values", async () => {
    render(<IntegrationConfig integration={entry("alexa")} onBack={() => {}} settingsApi={settings()} alexaApi={alexaApi()} />);
    expect((await screen.findByLabelText("Skill name")) as HTMLInputElement).toHaveProperty("value", "Friend Assistant");
    expect((screen.getByLabelText("Seconds to work on an answer") as HTMLInputElement).value).toBe("6.5");
    expect((screen.getByLabelText("Minutes to keep a late answer") as HTMLInputElement).value).toBe("10");
    expect((screen.getByLabelText("Seconds to wait for your yes on your phone") as HTMLInputElement).value).toBe("120");
    expect((screen.getByLabelText("Requests a minute allowed") as HTMLInputElement).value).toBe("60");
    expect((screen.getByLabelText("Echo devices allowed") as HTMLInputElement).value).toBe("10");
    expect((screen.getByRole("checkbox", { name: "English (India)" }) as HTMLInputElement).checked).toBe(true);
    expect((screen.getByRole("checkbox", { name: "Hindi (India)" }) as HTMLInputElement).checked).toBe(true);
  });

  it("sends only what changed, after the PIN", async () => {
    const s = settings();
    render(<IntegrationConfig integration={entry("alexa")} onBack={() => {}} settingsApi={s} alexaApi={alexaApi()} />);
    const seconds = await screen.findByLabelText("Seconds to work on an answer");
    await userEvent.clear(seconds);
    await userEvent.type(seconds, "5");
    await userEvent.type(screen.getByLabelText("Extra tools a voice may use without asking (one per line)"), "calendar.list");
    await userEvent.click(screen.getByRole("checkbox", { name: "Hindi (India)" }));
    await save();
    await waitFor(() => expect(s.save).toHaveBeenCalledWith({ alexa: { answerSeconds: 5, locales: ["en-IN"], extraVoiceTools: ["calendar.list"] } }, "123456"));
  });

  it("will not let the last language be switched off", async () => {
    render(<IntegrationConfig integration={entry("alexa")} onBack={() => {}} settingsApi={settings()} alexaApi={alexaApi()} />);
    await userEvent.click(await screen.findByRole("checkbox", { name: "Hindi (India)" }));
    await userEvent.click(screen.getByRole("checkbox", { name: "English (India)" }));
    expect((screen.getByRole("checkbox", { name: "English (India)" }) as HTMLInputElement).checked).toBe(true);
  });

  it("lists only the files for the languages in use", async () => {
    render(<IntegrationConfig integration={entry("alexa")} onBack={() => {}} settingsApi={settings()} alexaApi={alexaApi(["skill.json", "en-IN.json"])} />);
    expect(await screen.findByRole("link", { name: /en-IN\.json/ })).toBeTruthy();
    expect(screen.queryByRole("link", { name: /hi-IN\.json/ })).toBeNull();
  });
});

describe("Zerodha report options", () => {
  it("shows the current values and sends only what changed", async () => {
    const s = settings();
    render(<IntegrationConfig integration={entry("zerodha")} onBack={() => {}} settingsApi={s} brokersApi={brokersApi()} />);
    expect((await screen.findByLabelText("Currency sign") as HTMLInputElement).value).toBe("₹");
    expect((screen.getByLabelText("Number format (locale)") as HTMLInputElement).value).toBe("en-IN");
    expect((screen.getByLabelText("Mention a holding above this share of the portfolio (%)") as HTMLInputElement).value).toBe("30");
    const sign = screen.getByLabelText("Currency sign");
    await userEvent.clear(sign);
    await userEvent.type(sign, "$");
    const locale = screen.getByLabelText("Number format (locale)");
    await userEvent.clear(locale);
    await userEvent.type(locale, "en-US");
    const tries = screen.getByLabelText("Tries a day for a report");
    await userEvent.clear(tries);
    await userEvent.type(tries, "5");
    await save();
    await waitFor(() => expect(s.save).toHaveBeenCalledWith({ brokers: { currencySymbol: "$", numberLocale: "en-US", maxTriesPerDay: 5 } }, "123456"));
  });
});
