import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserForm } from "./BrowserForm";
import { IntegrationConfig } from "./IntegrationConfig";
import { TavilyForm } from "./TavilyForm";
import { DEFAULT_LOOK, type SettingsApi, type SettingsView } from "../settings/settingsApi";
import type { IntegrationEntry } from "./pluginsApi";

afterEach(cleanup);

const pad = async (digits: string) => {
  for (const d of digits) await userEvent.click(screen.getByRole("button", { name: d }));
};
const view = (over: Partial<SettingsView> = {}): SettingsView =>
  ({
    provider: "claude-code",
    model: "m",
    apiKeySet: false,
    view: "companion",
    approvals: "manual",
    look: { ...DEFAULT_LOOK },
    ollama: { url: "http://127.0.0.1:11434", model: "q", vision: false, contextTokens: 8192 },
    claudeCode: { model: "sonnet", command: "claude", fallback: "ollama" },
    voice: { enabled: true, speakTyped: true, language: null, accept: 0.72, challenge: 0.58, ttsVoice: "v", sttModel: "base" },
    web: { enabled: true, provider: "duckduckgo", searxngUrl: "", braveKeySet: false, tavilyKeySet: false, tavily: { installed: true, enabled: false, depth: "basic", maxResults: 5 } },
    browser: { installed: true, enabled: false, chromePath: "", timeoutSec: 20, maxChars: 12000 },
    ...over,
  }) as SettingsView;
const apiFor = (v: SettingsView): SettingsApi & { save: ReturnType<typeof vi.fn> } => ({ get: async () => v, save: vi.fn(async () => ({ settings: v, changed: [], restart: [] }) as never) });

describe("<TavilyForm>", () => {
  it("sends the key (write-only) with the depth and result count, only after the PIN", async () => {
    const api = apiFor(view());
    render(<TavilyForm api={api} />);
    const key = (await screen.findByLabelText("Tavily API key")) as HTMLInputElement;
    expect(key.type).toBe("password");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(key, "tvly-abc");
    await userEvent.selectOptions(screen.getByRole("combobox"), "advanced");
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    expect(api.save).not.toHaveBeenCalled();
    await pad("123456");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.save).toHaveBeenCalledWith({ web: { tavilyKey: "tvly-abc", tavily: { depth: "advanced" } } }, "123456");
  });

  it("never shows a saved key and sends nothing for an empty box", async () => {
    const api = apiFor(view({ web: { enabled: true, provider: "tavily", searxngUrl: "", braveKeySet: false, tavilyKeySet: true, tavily: { installed: true, enabled: true, depth: "basic", maxResults: 5 } } }));
    render(<TavilyForm api={api} />);
    const key = (await screen.findByLabelText("Tavily API key")) as HTMLInputElement;
    expect(key.value).toBe("");
    expect(key.placeholder).toBe("saved");
    expect((screen.getByRole("button", { name: "Save" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows a wrong PIN", async () => {
    const api = apiFor(view());
    api.save.mockRejectedValueOnce(new Error("Incorrect PIN"));
    render(<TavilyForm api={api} />);
    await userEvent.type(await screen.findByLabelText("Tavily API key"), "k");
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    await pad("000000");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findByRole("alert")).textContent).toBe("Incorrect PIN");
  });
});

describe("<BrowserForm>", () => {
  it("says which browser Friend found, and saves only what changed, with the PIN", async () => {
    const api = apiFor(view());
    render(<BrowserForm api={api} found="/opt/google/chrome/chrome" />);
    expect(await screen.findByText(/Friend will use: \/opt\/google\/chrome\/chrome/)).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Browser program"), "D:\\chrome\\chrome.exe");
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    await pad("123456");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    expect(api.save).toHaveBeenCalledWith({ browser: { chromePath: "D:\\chrome\\chrome.exe" } }, "123456");
  });

  it("says plainly when no browser was found", async () => {
    render(<BrowserForm api={apiFor(view())} found="" />);
    expect(await screen.findByText(/has not found Chrome or Edge/)).toBeTruthy();
  });
});

describe("<IntegrationConfig> for the two plugins", () => {
  const entry = (id: string, name: string, settings: IntegrationEntry["settings"] = {}): IntegrationEntry => ({ id, name, description: `${name} plugin`, installed: true, enabled: false, state: "needs-setup", detail: "Do the setup.", steps: [{ text: "A step", done: false }], settings });

  it("shows the Tavily form, not the messaging ones", async () => {
    render(<IntegrationConfig integration={entry("tavily", "Tavily search")} onBack={() => {}} settingsApi={apiFor(view())} />);
    expect(await screen.findByLabelText("Tavily API key")).toBeTruthy();
    expect(screen.queryByText(/Telegram/)).toBeNull();
  });

  it("shows the browser form with the program Friend found", async () => {
    render(<IntegrationConfig integration={entry("browser", "Safe browser", { chrome: "/usr/bin/chromium" })} onBack={() => {}} settingsApi={apiFor(view())} />);
    expect(await screen.findByText(/Friend will use: \/usr\/bin\/chromium/)).toBeTruthy();
  });
});
