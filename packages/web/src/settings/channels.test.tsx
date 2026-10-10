import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChannelsTab, type ChannelSecrets, type ChannelStatus, type ChannelsApi } from "./ChannelsTab";
import { SettingsPanel } from "./SettingsPanel";
import { DEFAULT_LOOK, diffSettings, needsPin, type SettingsApi, type SettingsView } from "./settingsApi";

afterEach(cleanup);

const view = (channels?: SettingsView["channels"]): SettingsView => ({
  provider: "claude-code",
  model: "claude-sonnet-5-5",
  apiKeySet: false,
  view: "companion",
  approvals: "manual",
  ...(channels ? { channels } : {}),
  look: { ...DEFAULT_LOOK },
  ollama: { url: "http://127.0.0.1:11434", model: "qwen2.5:7b", vision: false, contextTokens: 8192 },
  claudeCode: { model: "sonnet", command: "claude", fallback: "ollama" },
  voice: { enabled: true, speakTyped: true, language: null, accept: 0.72, challenge: 0.58, ttsVoice: "en_US-lessac-medium", sttModel: "base" },
});
const off = { telegram: { enabled: false, tokenSet: false, linked: false }, twilio: { enabled: false, accountSid: "", tokenSet: false, smsFrom: "", whatsappFrom: "", ownerNumber: "" } };
const status = (over: Partial<ChannelStatus["telegram"]> = {}, unread = 0): ChannelStatus => ({
  telegram: { enabled: true, tokenSet: true, linked: false, state: "online", detail: "", bot: "friend_bot", ...over },
  twilio: { enabled: true, tokenSet: true, ownerSet: true, sms: true, whatsapp: true, webhook: "https://friend.example.com/api/channels/twilio" },
  unread,
});

/** The tab with its own state, the way the settings panel holds it. */
function Harness({ start, api, onChange }: { start: SettingsView; api: ChannelsApi; onChange?: (draft: SettingsView, secrets: ChannelSecrets) => void }) {
  const [draft, setDraft] = useState(start);
  const [secrets, setSecrets] = useState<ChannelSecrets>({ telegramToken: "", twilioToken: "" });
  onChange?.(draft, secrets);
  return <ChannelsTab draft={draft} setDraft={setDraft} secrets={secrets} setSecrets={setSecrets} api={api} />;
}
const fakeApi = (s: ChannelStatus = status()): ChannelsApi => ({ status: vi.fn(async () => s), link: vi.fn(async () => ({ code: "ABCD2345", bot: "friend_bot", expiresInSeconds: 600 })), unlink: vi.fn(async () => {}) });

describe("the channels tab", () => {
  it("shows the state of Telegram and the address Twilio must call", async () => {
    render(<Harness start={view({ ...off, telegram: { enabled: true, tokenSet: true, linked: false }, twilio: { ...off.twilio, enabled: true } })} api={fakeApi(status({}, 2))} />);
    expect(await screen.findByText(/Connected as @friend_bot/)).toBeTruthy();
    expect(screen.getByText("https://friend.example.com/api/channels/twilio")).toBeTruthy();
    expect(screen.getByText(/2 unread messages/)).toBeTruthy();
  });

  it("shows why Telegram is not working", async () => {
    render(<Harness start={view({ ...off, telegram: { enabled: true, tokenSet: true, linked: false } })} api={fakeApi(status({ state: "error", detail: "Unauthorized" }))} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/Not working.*Unauthorized/);
  });

  it("never shows a saved token, only that one is saved", () => {
    render(<Harness start={view({ ...off, telegram: { enabled: true, tokenSet: true, linked: false }, twilio: { ...off.twilio, tokenSet: true } })} api={fakeApi()} />);
    for (const box of screen.getAllByPlaceholderText(/A token is saved/)) expect((box as HTMLInputElement).value).toBe("");
  });

  it("collects what was typed so the panel can save it with the PIN", async () => {
    let last: { draft: SettingsView; secrets: ChannelSecrets } | null = null;
    render(<Harness start={view(off)} api={fakeApi()} onChange={(draft, secrets) => (last = { draft, secrets })} />);
    await userEvent.click(screen.getByLabelText(/Switch Telegram on/));
    await userEvent.type(screen.getByLabelText("Bot token"), "123456789:ABCdefghijklmnopqrstuvwxyz1");
    await userEvent.type(screen.getByLabelText("Your own phone number"), "+919800000000");
    const patch = diffSettings(view(off), last!.draft, "", "", last!.secrets);
    expect(patch).toEqual({ channels: { telegram: { enabled: true, botToken: "123456789:ABCdefghijklmnopqrstuvwxyz1" }, twilio: { ownerNumber: "+919800000000" } } });
    expect(needsPin(patch)).toBe(true);
  });

  it("gets a link code with the PIN and tells what to send to the bot", async () => {
    const api = fakeApi();
    render(<Harness start={view({ ...off, telegram: { enabled: true, tokenSet: true, linked: false } })} api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Get a link code" }));
    expect(await screen.findByText(/Type your PIN first/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/PIN \(to link or unlink\)/), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Get a link code" }));
    expect(api.link).toHaveBeenCalledWith("123456");
    const code = await screen.findByText("/link ABCD2345");
    expect(code.closest("p")!.textContent).toMatch(/send: \/link ABCD2345.*10 minutes/);
  });

  it("shows a refusal, such as a wrong PIN", async () => {
    const api = fakeApi();
    (api.link as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Wrong PIN"));
    render(<Harness start={view({ ...off, telegram: { enabled: true, tokenSet: true, linked: false } })} api={api} />);
    await userEvent.type(await screen.findByLabelText(/PIN \(to link or unlink\)/), "000000");
    await userEvent.click(screen.getByRole("button", { name: "Get a link code" }));
    expect((await screen.findByText("Wrong PIN")).getAttribute("role")).toBe("alert");
  });

  it("can unlink a linked Telegram", async () => {
    const api = fakeApi(status({ linked: true }));
    render(<Harness start={view({ ...off, telegram: { enabled: true, tokenSet: true, linked: true } })} api={api} />);
    expect(await screen.findByText(/Your Telegram is linked/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText(/PIN \(to link or unlink\)/), "123456");
    await userEvent.click(screen.getByRole("button", { name: "Unlink" }));
    await waitFor(() => expect(api.unlink).toHaveBeenCalledWith("123456"));
  });
});

describe("the settings panel and channels", () => {
  it("has a Channels tab, and saves what is typed there only after the PIN", async () => {
    const start = view(off);
    const api: SettingsApi = { get: vi.fn(async () => start), save: vi.fn(async () => ({ settings: start, changed: true, restart: [] })) };
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => status() })));
    render(<SettingsPanel api={api} onClose={() => {}} initialTab="channels" />);
    await userEvent.click(await screen.findByLabelText(/Switch Telegram on/));
    await userEvent.type(screen.getByLabelText("Bot token"), "123456789:ABCdefghijklmnopqrstuvwxyz1");
    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(await screen.findByText(/Enter your PIN/)).toBeTruthy();
    for (const d of "123456") await userEvent.click(screen.getByRole("button", { name: d }));
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ channels: { telegram: { enabled: true, botToken: "123456789:ABCdefghijklmnopqrstuvwxyz1" } } }, "123456"));
    vi.unstubAllGlobals();
  });
});
