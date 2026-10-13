import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import { DEFAULT_LOOK, type SettingsApi, type SettingsView } from "./settingsApi";

afterEach(cleanup);

const view: SettingsView = {
  provider: "claude-code",
  model: "claude-sonnet-5-5",
  apiKeySet: false,
  view: "companion",
  look: { ...DEFAULT_LOOK },
  ollama: { url: "http://127.0.0.1:11434", model: "qwen2.5:7b", vision: false, contextTokens: 8192 },
  claudeCode: { model: "sonnet", command: "claude", fallback: "ollama" },
  voice: { enabled: true, speakTyped: true, language: null, accept: 0.72, challenge: 0.58, ttsVoice: "en_US-lessac-medium", sttModel: "small", duck: true, duckPercent: 25 },
};

function setup(start: SettingsView = view) {
  const api: SettingsApi = { get: vi.fn(async () => start), save: vi.fn(async () => ({ settings: start, changed: true, restart: [] })) };
  render(<SettingsPanel api={api} onClose={() => {}} initialTab="voice" preview={async () => {}} />);
  return api;
}
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const save = async () => {
  await userEvent.click(screen.getByRole("button", { name: /save/i }));
  await typePin("123456");
  await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
};

describe("turning music and video down while talking, in the settings", () => {
  it("shows the switch and the level that are set", async () => {
    setup();
    const on = (await screen.findByLabelText(/turn music and video down/i)) as HTMLInputElement;
    expect(on.checked).toBe(true);
    const level = screen.getByLabelText(/volume while talking/i) as HTMLInputElement;
    expect(level.value).toBe("25");
    expect(screen.getByText(/25%/)).toBeTruthy();
  });

  it("saves a new level", async () => {
    const api = setup();
    const level = (await screen.findByLabelText(/volume while talking/i)) as HTMLInputElement;
    fireEvent.change(level, { target: { value: "40" } });
    await save();
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ voice: { duckPercent: 40 } }, "123456"));
  });

  it("saves the switch being turned off, and the level cannot be changed while it is off", async () => {
    const api = setup();
    await userEvent.click(await screen.findByLabelText(/turn music and video down/i));
    expect((screen.getByLabelText(/volume while talking/i) as HTMLInputElement).disabled).toBe(true);
    await save();
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ voice: { duck: false } }, "123456"));
  });

  it("still opens for a server that does not know the setting yet, showing the usual level", async () => {
    const old = { ...view, voice: { ...view.voice } };
    delete (old.voice as { duck?: boolean }).duck;
    delete (old.voice as { duckPercent?: number }).duckPercent;
    setup(old);
    expect((await screen.findByLabelText(/volume while talking/i) as HTMLInputElement).value).toBe("25");
  });
});
