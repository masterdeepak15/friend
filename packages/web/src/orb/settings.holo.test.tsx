import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../settings/SettingsPanel";
import { DEFAULT_LOOK, type SettingsApi, type SettingsView } from "../settings/settingsApi";

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

function setup(over: Partial<SettingsApi> = {}, initialTab: "model" | "voice" = "model") {
  const api: SettingsApi = { get: vi.fn(async () => view), save: vi.fn(async () => ({ settings: view, changed: true, restart: [] })), ...over };
  const onClose = vi.fn();
  render(<SettingsPanel api={api} onClose={onClose} initialTab={initialTab} preview={async () => {}} variant="holo" />);
  return { api, onClose };
}
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};

describe("the settings in the glass panel", () => {
  it("shows the page that was asked for, with the same settings as the classic panel", async () => {
    setup({}, "voice");
    expect(await screen.findByRole("heading", { name: "Voice" })).toBeTruthy();
    expect(screen.getByLabelText(/speaking voice/i)).toBeTruthy();
    expect(screen.queryByRole("tablist")).toBeNull(); // the arrows replace the tab strip
  });

  it("pages through every settings page with the arrows, round and round", async () => {
    setup();
    expect(await screen.findByRole("heading", { name: "Model" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByRole("heading", { name: "Voice" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(screen.getByRole("heading", { name: "Security" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByRole("heading", { name: "Model" })).toBeTruthy();
  });

  it("keeps what was typed when paging away and back", async () => {
    setup({}, "voice");
    const select = (await screen.findByLabelText(/listening model/i)) as HTMLSelectElement;
    await userEvent.selectOptions(select, "small");
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect((screen.getByLabelText(/listening model/i) as HTMLSelectElement).value).toBe("small");
  });

  it("applies through the same save, with the PIN where one is needed, and stays open", async () => {
    const { api, onClose } = setup({}, "voice");
    await userEvent.selectOptions(await screen.findByLabelText(/listening model/i), "small");
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ voice: { sttModel: "small" } }, "123456"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("has Apply waiting until something is changed", async () => {
    setup();
    await screen.findByRole("heading", { name: "Model" });
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes with Done when nothing was changed", async () => {
    const { onClose } = setup();
    await screen.findByRole("heading", { name: "Model" });
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("warns on Done when there are changes that were not applied, and Undo takes them back", async () => {
    const { onClose } = setup({}, "voice");
    const select = (await screen.findByLabelText(/listening model/i)) as HTMLSelectElement;
    await userEvent.selectOptions(select, "small");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/not applied/i);
    await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect((screen.getByLabelText(/listening model/i) as HTMLSelectElement).value).toBe("base");
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is still the classic panel unless asked for the glass one", async () => {
    const api: SettingsApi = { get: vi.fn(async () => view), save: vi.fn(async () => ({ settings: view, changed: true, restart: [] })) };
    render(<SettingsPanel api={api} onClose={() => {}} preview={async () => {}} />);
    expect(await screen.findByRole("tablist")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });
});
