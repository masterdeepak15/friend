import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationConfig } from "../plugins/IntegrationConfig";
import { PluginsPanel } from "../plugins/PluginsPanel";
import type { IntegrationEntry, PluginList, PluginsApi } from "../plugins/pluginsApi";
import { initialState, reduce } from "../store";
import { TelegramForm, TwilioForm, type ChannelStatus, type ChannelsApi } from "./ChannelsTab";
import { DEFAULT_LOOK, type ChannelsView, type SettingsApi, type SettingsView } from "./settingsApi";

afterEach(cleanup);

const off: ChannelsView = {
  telegram: { installed: false, enabled: false, tokenSet: false, linked: false },
  twilio: { installed: false, enabled: false, accountSid: "", tokenSet: false, smsFrom: "", whatsappFrom: "", ownerNumber: "" },
};
const view = (channels: ChannelsView): SettingsView => ({
  provider: "claude-code",
  model: "claude-sonnet-5-5",
  apiKeySet: false,
  view: "companion",
  approvals: "manual",
  channels,
  look: { ...DEFAULT_LOOK },
  ollama: { url: "http://127.0.0.1:11434", model: "qwen2.5:7b", vision: false, contextTokens: 8192 },
  claudeCode: { model: "sonnet", command: "claude", fallback: "ollama" },
  voice: { enabled: true, speakTyped: true, language: null, accept: 0.72, challenge: 0.58, ttsVoice: "en_US-lessac-medium", sttModel: "base" },
});
const entry = (over: Partial<IntegrationEntry> & { id: string }): IntegrationEntry => ({
  name: over.id === "telegram" ? "Telegram" : "WhatsApp and SMS (Twilio)",
  description: "Talk to Friend from your phone.",
  installed: false,
  enabled: false,
  state: "not-installed",
  detail: "",
  steps: [{ text: "Create a bot with @BotFather.", done: false }, { text: "Paste the token.", done: false }],
  ...over,
});
const status = (over: Partial<ChannelStatus["telegram"]> = {}): ChannelStatus => ({
  telegram: { enabled: true, tokenSet: true, linked: false, state: "online", detail: "", bot: "friend_bot", ...over },
  twilio: { enabled: true, tokenSet: true, ownerSet: true, sms: true, whatsapp: true, webhook: "https://friend.example.com/api/channels/twilio" },
  unread: 0,
});
const channelsApi = (s: ChannelStatus = status()): ChannelsApi => ({ status: vi.fn(async () => s), link: vi.fn(async () => ({ code: "ABCD2345", bot: "friend_bot", expiresInSeconds: 600 })), unlink: vi.fn(async () => {}) });
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};

/** A plugins api whose list changes as things are done, the way the server's does. */
function pluginsApi(start: IntegrationEntry[]) {
  let integrations = start;
  const list = (): PluginList => ({ installed: [], catalog: [], integrations });
  const api: PluginsApi = {
    list: vi.fn(async () => list()),
    install: vi.fn(async (id) => {
      integrations = integrations.map((i) => (i.id === id ? { ...i, installed: true, state: "needs-setup", detail: "Add the bot token (press Configure)." } : i));
    }),
    setEnabled: vi.fn(async (id, enabled) => {
      integrations = integrations.map((i) => (i.id === id ? { ...i, enabled, state: enabled ? "online" : "off", detail: enabled ? "Connected as @friend_bot." : "Switched off." } : i));
    }),
    remove: vi.fn(async (id) => {
      integrations = integrations.map((i) => (i.id === id ? entry({ id }) : i));
    }),
    reload: vi.fn(async () => {}),
  };
  return api;
}

describe("the plugins screen lists the integrations next to the other plugins", () => {
  it("offers Telegram and Twilio under Available, with an Install button", async () => {
    render(<PluginsPanel api={pluginsApi([entry({ id: "telegram" }), entry({ id: "twilio" })])} onClose={() => {}} />);
    const telegram = await screen.findByText("Telegram");
    expect(telegram.closest("li")!.getAttribute("data-integration")).toBe("telegram");
    expect(within(telegram.closest("li")!).getByRole("button", { name: "Install" })).toBeTruthy();
    expect(screen.getByText("WhatsApp and SMS (Twilio)")).toBeTruthy();
  });

  it("installs with the PIN, and then shows it under Installed with Configure, Turn on and Remove", async () => {
    const api = pluginsApi([entry({ id: "telegram" })]);
    render(<PluginsPanel api={api} onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Install" }));
    expect(screen.getByText(/Install Telegram\? It connects Friend to an outside service/)).toBeTruthy();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.install).toHaveBeenCalledWith("telegram", "123456"));
    const row = (await screen.findByText(/Add the bot token/)).closest("li")!;
    expect(within(row).getByRole("button", { name: "Configure" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Turn on" })).toBeTruthy();
    expect(within(row).getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(within(row).getByText("Needs setup")).toBeTruthy();
  });

  it("switches on with the PIN and off without it, and removes", async () => {
    const api = pluginsApi([entry({ id: "telegram", installed: true, state: "off", detail: "Switched off." })]);
    render(<PluginsPanel api={api} onClose={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: "Turn on" }));
    expect(screen.getByText(/Switch on Telegram\?/)).toBeTruthy();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith("telegram", true, "123456"));
    expect(await screen.findByText(/Connected as @friend_bot/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith("telegram", false, undefined));
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("telegram"));
    expect(await screen.findByRole("button", { name: "Install" })).toBeTruthy();
  });

  it("shows why an integration is not working", async () => {
    render(<PluginsPanel api={pluginsApi([entry({ id: "telegram", installed: true, enabled: true, state: "error", detail: "Unauthorized" })])} onClose={() => {}} />);
    const detail = await screen.findByText("Unauthorized");
    expect(detail.className).toBe("auth-error");
    expect(screen.getByText("Not working")).toBeTruthy();
  });

  it("opens straight at an integration's Configure page when the assistant asks", async () => {
    const api = pluginsApi([entry({ id: "telegram", installed: true, state: "needs-setup", detail: "Add the bot token (press Configure)." })]);
    // the Configure page reads the settings and the channel status over the network
    vi.stubGlobal("fetch", vi.fn(async (url: string) => ({ ok: true, status: 200, json: async () => (url === "/api/channels" ? status() : view(off)) })));
    render(<PluginsPanel api={api} onClose={() => {}} initialConfigure="telegram" />);
    expect(await screen.findByRole("heading", { name: "Telegram" })).toBeTruthy();
    expect(await screen.findByLabelText("Bot token")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Install" })).toBeNull(); // not the list
    vi.unstubAllGlobals();
  });
});

describe("the Configure page", () => {
  const telegram = entry({ id: "telegram", installed: true, state: "needs-setup", detail: "Add the bot token (press Configure)." });
  const twilio = entry({ id: "twilio", installed: true, state: "needs-setup", detail: "Add the account SID and auth token (press Configure)." });

  it("lists the steps with what is done, and saves a token only after the PIN, as a write-only value", async () => {
    const settings: SettingsApi = { get: vi.fn(async () => view(off)), save: vi.fn(async () => ({ settings: view({ ...off, telegram: { installed: true, enabled: false, tokenSet: true, linked: false } }), changed: true, restart: [] })) };
    render(<IntegrationConfig integration={{ ...telegram, steps: [{ text: "Create a bot with @BotFather.", done: true }, { text: "Paste the token.", done: false }] }} onBack={() => {}} settingsApi={settings} channelsApi={channelsApi()} />);
    expect(await screen.findByText("Create a bot with @BotFather.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Save" }).hasAttribute("disabled")).toBe(true); // nothing changed yet
    await userEvent.type(screen.getByLabelText("Bot token"), "123456789:ABCdefghijklmnopqrstuvwxyz1");
    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(await screen.findByText(/Enter your PIN to save/)).toBeTruthy();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(settings.save).toHaveBeenCalledWith({ channels: { telegram: { botToken: "123456789:ABCdefghijklmnopqrstuvwxyz1" } } }, "123456"));
    expect(await screen.findByText(/Saved\. Now press Turn on/)).toBeTruthy();
    expect((screen.getByLabelText("Bot token") as HTMLInputElement).value).toBe(""); // the token is gone from the box
  });

  it("Twilio: sends only the fields that changed", async () => {
    const start = { ...off, twilio: { installed: true, enabled: false, accountSid: "AC" + "a".repeat(30), tokenSet: true, smsFrom: "+14155550100", whatsappFrom: "", ownerNumber: "" } };
    const settings: SettingsApi = { get: vi.fn(async () => view(start)), save: vi.fn(async () => ({ settings: view(start), changed: true, restart: [] })) };
    render(<IntegrationConfig integration={twilio} onBack={() => {}} settingsApi={settings} channelsApi={channelsApi()} />);
    await userEvent.type(await screen.findByLabelText("Your own phone number"), "+919800000000");
    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(settings.save).toHaveBeenCalledWith({ channels: { twilio: { ownerNumber: "+919800000000" } } }, "123456"));
  });

  it("shows a refusal such as a wrong PIN, and goes back", async () => {
    const settings: SettingsApi = { get: vi.fn(async () => view(off)), save: vi.fn(async () => { throw new Error("Incorrect PIN"); }) };
    const back = vi.fn();
    render(<IntegrationConfig integration={telegram} onBack={back} settingsApi={settings} channelsApi={channelsApi()} />);
    await userEvent.type(await screen.findByLabelText("Bot token"), "123456789:ABCdefghijklmnopqrstuvwxyz1");
    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    await typePin("000000");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect((await screen.findByRole("alert")).textContent).toBe("Incorrect PIN");
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(back).toHaveBeenCalled();
  });
});

describe("the forms", () => {
  const Harness = ({ api }: { api: ChannelsApi }) => {
    const [secret, setSecret] = useState("");
    return <TelegramForm view={{ installed: true, enabled: true, tokenSet: true, linked: false }} secret={secret} setSecret={setSecret} api={api} />;
  };

  it("Telegram: gets a link code with the PIN and says what to send to the bot", async () => {
    const api = channelsApi();
    render(<Harness api={api} />);
    expect(await screen.findByText(/Connected as @friend_bot/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Get a link code" }));
    expect(await screen.findByText(/Type your PIN first/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/PIN \(to link or unlink\)/), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Get a link code" }));
    expect(api.link).toHaveBeenCalledWith("123456");
    expect((await screen.findByText("/link ABCD2345")).closest("p")!.textContent).toMatch(/10 minutes/);
  });

  it("Telegram: can unlink", async () => {
    const api = channelsApi(status({ linked: true }));
    render(<TelegramForm view={{ installed: true, enabled: true, tokenSet: true, linked: true }} secret="" setSecret={() => {}} api={api} />);
    expect(await screen.findByText(/Your Telegram is linked/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/PIN \(to link or unlink\)/), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(api.unlink).toHaveBeenCalledWith("123456"));
    expect(await screen.findByText(/Not linked yet/)).toBeTruthy();
  });

  it("Telegram: tells the owner to switch the plugin on first", () => {
    render(<TelegramForm view={{ installed: true, enabled: false, tokenSet: true, linked: false }} secret="" setSecret={() => {}} api={channelsApi()} />);
    expect(screen.getByText(/Switch the plugin on \(Turn on\)/)).toBeTruthy();
  });

  it("Twilio: shows the address Twilio must call, or that none is set", () => {
    const v = { installed: true, enabled: true, accountSid: "", tokenSet: false, smsFrom: "", whatsappFrom: "", ownerNumber: "" };
    const { rerender } = render(<TwilioForm view={v} setView={() => {}} secret="" setSecret={() => {}} webhook="https://friend.example.com/api/channels/twilio" />);
    expect(screen.getByText("https://friend.example.com/api/channels/twilio")).toBeTruthy();
    rerender(<TwilioForm view={v} setView={() => {}} secret="" setSecret={() => {}} webhook={null} />);
    expect(screen.getByText(/No public address is set yet/)).toBeTruthy();
  });
});

describe("the assistant opening the plugins screen", () => {
  it("is remembered by the store, with the integration, and every request counts", () => {
    let s = reduce(initialState, { type: "ui.open", panel: "plugins", integration: "telegram" });
    expect(s.uiOpen).toEqual({ n: 1, integration: "telegram" });
    s = reduce(s, { type: "ui.open", panel: "plugins" });
    expect(s.uiOpen).toEqual({ n: 2 });
  });
});
