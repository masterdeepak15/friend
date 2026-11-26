import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import { DEFAULT_LOOK, type SettingsApi, type SettingsView } from "./settingsApi";

afterEach(cleanup);

const view = {
  provider: "openai",
  model: "claude-sonnet-5-5",
  apiKeySet: false,
  view: "companion",
  look: { ...DEFAULT_LOOK },
  ollama: { url: "http://127.0.0.1:11434", model: "qwen2.5:7b", vision: false, contextTokens: 8192 },
  claudeCode: { model: "sonnet", command: "claude", fallback: "ollama" },
  openai: { url: "http://localhost:20128/v1", model: "auto", vision: false, apiKeySet: true },
  voice: { enabled: true, speakTyped: true, language: null, accept: 0.72, challenge: 0.58, ttsVoice: "en_US-lessac-medium", sttModel: "small", duck: true, duckPercent: 25 },
} as unknown as SettingsView;

function setup() {
  const api: SettingsApi = { get: vi.fn(async () => view), save: vi.fn(async () => ({ settings: view, changed: true, restart: [] })) };
  render(<SettingsPanel api={api} onClose={() => {}} preview={async () => {}} />);
  return api;
}
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};

describe("choosing an OpenAI-compatible service in the settings", () => {
  it("lists the services, and picking Grok fills the address and a model", async () => {
    setup();
    const service = (await screen.findByLabelText("Service")) as HTMLSelectElement;
    const names = [...service.options].map((o) => o.textContent);
    expect(names).toEqual(expect.arrayContaining([expect.stringContaining("OmniRoute"), "Grok (xAI)", "Google Gemini", "OpenRouter", "NVIDIA NIM", "Z.ai (GLM)", "OpenCode Zen", "Another server (type the address)"]));
    await userEvent.selectOptions(service, "xai");
    expect((screen.getByLabelText(/Server address/) as HTMLInputElement).value).toBe("https://api.x.ai/v1");
    expect(screen.getAllByLabelText(/^Model/).map((el) => (el as HTMLInputElement).value)).toContain("grok-4");
  });

  it("says the saved key is for the old server once the service is changed, and saves the new address", async () => {
    const api = setup();
    await userEvent.selectOptions(await screen.findByLabelText("Service"), "openrouter");
    expect(screen.getByText(/belongs to the old server and is removed/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith(expect.objectContaining({ openai: expect.objectContaining({ url: "https://openrouter.ai/api/v1" }) }), "123456"));
  });
});
