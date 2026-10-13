import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  voice: { enabled: true, speakTyped: true, language: null, accept: 0.72, challenge: 0.58, ttsVoice: "en_US-lessac-medium", sttModel: "base" },
};

function setup(over: Partial<SettingsApi> = {}, start: SettingsView = view) {
  const api: SettingsApi = { get: vi.fn(async () => start), save: vi.fn(async () => ({ settings: start, changed: true, restart: [] })), ...over };
  render(<SettingsPanel api={api} onClose={() => {}} initialTab="model" preview={async () => {}} />);
  return api;
}
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const open = async () => {
  await userEvent.click(await screen.findByRole("tab", { name: /^Voice\s*Speaking/ }));
  return screen.getByLabelText(/listening model/i) as HTMLSelectElement;
};

describe("choosing the listening model in the settings", () => {
  it("offers the models with how big each is, and the current one is chosen", async () => {
    setup();
    const select = await open();
    expect(select.tagName).toBe("SELECT");
    expect(select.value).toBe("base");
    const labels = [...select.options].map((o) => o.textContent);
    expect(labels).toEqual([expect.stringMatching(/Tiny.*75 MB/), expect.stringMatching(/Base.*145 MB/), expect.stringMatching(/Small.*480 MB.*recommended/), expect.stringMatching(/Medium.*1\.5 GB/), expect.stringMatching(/Large \(turbo\).*1\.6 GB/)]);
  });

  it("keeps a model that is not in the list (set from the command line) instead of losing it", async () => {
    setup({}, { ...view, voice: { ...view.voice, sttModel: "distil-large-v3" } });
    const select = await open();
    expect(select.value).toBe("distil-large-v3");
  });

  it("saves the chosen model and says it is downloading, with no restart", async () => {
    const api = setup();
    const select = await open();
    await userEvent.selectOptions(select, "small");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ voice: { sttModel: "small" } }, "123456"));
    const note = await screen.findByText(/listening model is being downloaded/i);
    expect(note.textContent).not.toMatch(/restart/i);
  });
});
