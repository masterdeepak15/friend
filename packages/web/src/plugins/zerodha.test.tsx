import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginsPanel } from "./PluginsPanel";
import { SettingsPanel } from "../settings/SettingsPanel";
import { TradingTab } from "../settings/TradingTab";
import { DEFAULT_LOOK, type SettingsApi, type SettingsView } from "../settings/settingsApi";
import { IntegrationConfig } from "./IntegrationConfig";
import type { BrokersApi, BrokersStatus } from "./ZerodhaForm";
import type { IntegrationEntry, PluginsApi } from "./pluginsApi";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const entry = (over: Partial<IntegrationEntry> = {}): IntegrationEntry => ({
  id: "zerodha",
  name: "Zerodha",
  description: "Read-only look at your Zerodha portfolio.",
  installed: true,
  enabled: true,
  state: "needs-setup",
  detail: "Log in to Zerodha (press Configure). Zerodha asks for this once a day.",
  steps: [{ text: "Create a free Kite Connect app.", done: true }, { text: "Log in to Zerodha with the link in Configure.", done: false }],
  ...over,
});
const view = (zerodha = { installed: true, enabled: true, apiKey: "abc123", secretSet: true }): SettingsView => ({
  provider: "claude-code",
  model: "claude-sonnet-5-5",
  apiKeySet: false,
  view: "companion",
  approvals: "manual",
  look: { ...DEFAULT_LOOK },
  ollama: { url: "http://127.0.0.1:11434", model: "qwen2.5:7b", vision: false, contextTokens: 8192 },
  claudeCode: { model: "sonnet", command: "claude", fallback: "ollama" },
  voice: { enabled: true, speakTyped: true, language: null, accept: 0.72, challenge: 0.58, ttsVoice: "en_US-lessac-medium", sttModel: "base" },
  brokers: { zerodha, timezone: "Asia/Kolkata", skipDates: [], loginReminderMinutes: 15, currencySymbol: "₹", currencyName: "rupees", numberLocale: "en-IN", concentrationPct: 30, bigDropPct: 5, cacheSeconds: 30, maxSchedules: 20, maxTriesPerDay: 3 },
  trading: { level: "read" },
});
const settingsApi = (v = view()): SettingsApi => ({ get: vi.fn(async () => v), save: vi.fn(async () => ({ settings: v, changed: true, restart: [] })) });
const status = (over: Partial<BrokersStatus["zerodha"]> = {}, schedules: BrokersStatus["schedules"] = []): BrokersStatus => ({
  zerodha: { installed: true, enabled: true, keySet: true, secretSet: true, loggedIn: false, expiresAt: null, detail: "Login needed: open the login link and sign in at Zerodha.", ...over },
  schedules,
  redirectUrl: "https://friend.example.com/api/brokers/zerodha/callback",
  timezone: "Asia/Kolkata",
});
const sched = { id: 4, name: "Morning", broker: "zerodha", kind: "morning" as const, time: "09:30", days: [1, 2, 3, 4, 5], channel: "telegram" as const, commentary: false, enabled: true, lastRunDay: null };
const brokersApi = (s: BrokersStatus = status()): BrokersApi => ({
  status: vi.fn(async () => s),
  loginLink: vi.fn(async (send: boolean) => (send ? { sent: true, via: "telegram" } : { url: "https://kite.zerodha.com/connect/login?v=3&api_key=abc123" })),
  runNow: vi.fn(async () => ({ text: "Portfolio report - Zerodha\nPortfolio: ₹1,00,000.00" })),
  addSchedule: vi.fn(async () => {}),
  removeSchedule: vi.fn(async () => {}),
});
const open = (b: BrokersApi, s: SettingsApi = settingsApi()) => render(<IntegrationConfig integration={entry()} onBack={() => {}} settingsApi={s} brokersApi={b} />);

describe("the Zerodha Configure page", () => {
  it("shows the address to register, the key, a write-only secret, the steps and the data notice", async () => {
    open(brokersApi());
    expect(await screen.findByRole("heading", { name: "Zerodha" })).toBeTruthy();
    expect(await screen.findByText("https://friend.example.com/api/brokers/zerodha/callback")).toBeTruthy();
    expect((screen.getByLabelText("API key") as HTMLInputElement).value).toBe("abc123");
    const secret = screen.getByLabelText("API secret") as HTMLInputElement;
    expect(secret.type).toBe("password");
    expect(secret.value).toBe("");
    expect(secret.placeholder).toMatch(/A secret is saved/);
    expect(screen.getByText("Create a free Kite Connect app.")).toBeTruthy();
    expect(screen.getByText(/Anthropic|Ollama/)).toBeTruthy();
    expect(screen.getByText(/Telegram or WhatsApp/)).toBeTruthy();
    expect(screen.getByText(/cannot place orders/i)).toBeTruthy();
  });

  it("opens the Zerodha login in a new tab and can send the link to the phone", async () => {
    const api = brokersApi();
    const opened = vi.fn();
    vi.stubGlobal("open", opened);
    open(api);
    await userEvent.click(await screen.findByRole("button", { name: "Open Zerodha login" }));
    await waitFor(() => expect(opened).toHaveBeenCalledWith("https://kite.zerodha.com/connect/login?v=3&api_key=abc123", "_blank", "noopener,noreferrer"));
    expect(api.loginLink).toHaveBeenCalledWith(false);
    await userEvent.click(screen.getByRole("button", { name: "Send me the login link on Telegram" }));
    await waitFor(() => expect(api.loginLink).toHaveBeenCalledWith(true));
    expect(await screen.findByText(/link was sent/i)).toBeTruthy();
  });

  it("says the login is needed when it has ended, and when it is active", async () => {
    open(brokersApi());
    expect(await screen.findByText(/Login needed/)).toBeTruthy();
    cleanup();
    open(brokersApi(status({ loggedIn: true, detail: "Logged in. The login ends at 6 am tomorrow." })));
    expect(await screen.findByText(/Logged in\. The login ends/)).toBeTruthy();
  });

  it("sends only the changed fields, after the PIN", async () => {
    const s = settingsApi();
    open(brokersApi(), s);
    const key = await screen.findByLabelText("API key");
    await userEvent.clear(key);
    await userEvent.type(key, "newkey1");
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(s.save).toHaveBeenCalledWith({ brokers: { zerodha: { apiKey: "newkey1" } } }, "123456"));
  });

  it("sends a typed secret on its own, and nothing when nothing changed", async () => {
    const s = settingsApi();
    open(brokersApi(), s);
    expect((await screen.findByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("API secret"), "SECRET-VALUE");
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(s.save).toHaveBeenCalledWith({ brokers: { zerodha: { apiSecret: "SECRET-VALUE" } } }, "123456"));
  });

  it("shows the report when 'Send a report now' is pressed, and the reason when it cannot", async () => {
    const api = brokersApi();
    open(api);
    await userEvent.click(await screen.findByRole("button", { name: "Show a report now" }));
    expect(await screen.findByText(/Portfolio: ₹1,00,000\.00/)).toBeTruthy();
    vi.mocked(api.runNow).mockRejectedValueOnce(new Error("Login needed: the Zerodha login has ended."));
    await userEvent.click(screen.getByRole("button", { name: "Show a report now" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Login needed/);
  });
});

describe("schedules on the Configure page", () => {
  it("lists them and removes one", async () => {
    const api = brokersApi(status({}, [sched]));
    open(api);
    const row = (await screen.findByText(/Morning/)).closest("li")!;
    expect(row.textContent).toMatch(/09:30/);
    expect(row.textContent).toMatch(/Telegram/);
    await userEvent.click(within(row).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.removeSchedule).toHaveBeenCalledWith(4));
  });

  it("adds one with the PIN, after checking the time and the days", async () => {
    const api = brokersApi();
    open(api);
    await userEvent.click(await screen.findByRole("button", { name: "Add a report" }));
    const time = screen.getByLabelText("Time (24 hour)") as HTMLInputElement;
    await userEvent.clear(time);
    await userEvent.type(time, "25:00");
    await userEvent.click(screen.getByRole("button", { name: "Add report…" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/09:30|HH:MM|time/i);
    expect(api.addSchedule).not.toHaveBeenCalled();
    await userEvent.clear(time);
    await userEvent.type(time, "09:30");
    await userEvent.click(screen.getByRole("button", { name: "Add report…" }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Add report" }));
    await waitFor(() => expect(api.addSchedule).toHaveBeenCalledWith({ name: "Morning report", kind: "morning", time: "09:30", days: [1, 2, 3, 4, 5], channel: "telegram" }, "123456"));
  });

  it("will not add a report with no day chosen", async () => {
    const api = brokersApi();
    open(api);
    await userEvent.click(await screen.findByRole("button", { name: "Add a report" }));
    for (const d of ["Mon", "Tue", "Wed", "Thu", "Fri"]) await userEvent.click(screen.getByRole("checkbox", { name: d }));
    await userEvent.click(screen.getByRole("button", { name: "Add report…" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/day/i);
    expect(api.addSchedule).not.toHaveBeenCalled();
  });
});

describe("the Trading tab", () => {
  it("shows Read only chosen and the order levels locked for a later version", () => {
    render(<TradingTab level="read" />);
    expect((screen.getByRole("radio", { name: /Read only/ }) as HTMLInputElement).checked).toBe(true);
    const locked = screen.getAllByRole("radio").filter((r) => (r as HTMLInputElement).disabled);
    expect(locked).toHaveLength(2);
    expect(screen.getAllByText(/later version/i).length).toBeGreaterThanOrEqual(2);
  });

  it("is a tab in the settings, before Security, and saves nothing", async () => {
    const s = settingsApi();
    render(<SettingsPanel api={s} onClose={() => {}} initialTab="trading" />);
    expect(await screen.findByRole("radio", { name: /Read only/ })).toBeTruthy();
    const tabs = screen.getAllByRole("tab").map((t) => t.textContent ?? "");
    expect(tabs.findIndex((t) => t.startsWith("Trading"))).toBeLessThan(tabs.findIndex((t) => t.startsWith("Security")));
    expect(s.save).not.toHaveBeenCalled();
  });
});

describe("the plugins list", () => {
  it("offers Zerodha under Available with Install", async () => {
    const api: PluginsApi = {
      list: vi.fn(async () => ({ installed: [], catalog: [], integrations: [entry({ installed: false, enabled: false, state: "not-installed", detail: "" })] })),
      install: vi.fn(async () => {}),
      setEnabled: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
    };
    render(<PluginsPanel api={api} onClose={() => {}} />);
    const row = (await screen.findByText("Zerodha")).closest("li")!;
    expect(row.getAttribute("data-integration")).toBe("zerodha");
    expect(within(row).getByRole("button", { name: "Install" })).toBeTruthy();
  });
});
