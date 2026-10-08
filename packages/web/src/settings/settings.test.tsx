import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerMenu } from "../overlay/OwnerMenu";
import { SettingsPanel } from "./SettingsPanel";
import { diffSettings, type SettingsApi, type SettingsView } from "./settingsApi";

afterEach(cleanup);

const view: SettingsView = {
  provider: "claude-code",
  model: "claude-sonnet-5-5",
  apiKeySet: false,
  view: "companion",
  ollama: { url: "http://127.0.0.1:11434", model: "qwen2.5:7b", vision: false, contextTokens: 8192 },
  claudeCode: { model: "sonnet", command: "claude", fallback: "ollama" },
  voice: { enabled: true, speakTyped: true, language: null, accept: 0.72, challenge: 0.58, ttsVoice: "en_US-lessac-medium", sttModel: "base" },
};

function setup(overrides: Partial<SettingsApi> = {}, start: SettingsView = view) {
  const api: SettingsApi = {
    get: vi.fn(async () => start),
    save: vi.fn(async () => ({ settings: start, changed: true, restart: [] })),
    ...overrides,
  };
  const onClose = vi.fn();
  render(<SettingsPanel api={api} onClose={onClose} />);
  return { api, onClose };
}
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};

describe("<SettingsPanel>", () => {
  it("shows the current choice and only the fields that belong to it", async () => {
    setup();
    expect(await screen.findByLabelText(/model provider/i)).toHaveProperty("value", "claude-code");
    expect(screen.getByLabelText(/claude model/i)).toHaveProperty("value", "sonnet");
    expect(screen.queryByLabelText(/^api key/i)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText(/model provider/i), "claude");
    expect(screen.getByLabelText(/^api key/i)).toBeTruthy();
    expect(screen.queryByLabelText(/claude code command/i)).toBeNull();
  });

  it("lets the owner choose the view and sends just that", async () => {
    const { api } = setup();
    await userEvent.selectOptions(await screen.findByLabelText(/^view/i), "workspace");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ view: "workspace" }, "123456"));
  });

  it("cannot be saved until something changes", async () => {
    setup();
    await screen.findByLabelText(/model provider/i);
    expect(screen.getByRole("button", { name: /save/i })).toHaveProperty("disabled", true);
    await userEvent.clear(screen.getByLabelText(/claude model/i));
    await userEvent.type(screen.getByLabelText(/claude model/i), "haiku");
    expect(screen.getByRole("button", { name: /save/i })).toHaveProperty("disabled", false);
  });

  it("asks for the PIN, sends only what changed, and says it is in use", async () => {
    const saved: SettingsView = { ...view, claudeCode: { ...view.claudeCode, model: "haiku" } };
    const { api } = setup({ save: vi.fn(async () => ({ settings: saved, changed: true, restart: [] })) });
    await screen.findByLabelText(/model provider/i);
    await userEvent.clear(screen.getByLabelText(/claude model/i));
    await userEvent.type(screen.getByLabelText(/claude model/i), "haiku");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(screen.getByText(/enter your pin/i)).toBeTruthy();
    expect(api.save).not.toHaveBeenCalled();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ claudeCode: { model: "haiku" } }, "123456"));
    expect(await screen.findByText(/in use now/i)).toBeTruthy();
  });

  it("shows a wrong PIN, stays on the PIN page, and clears the PIN", async () => {
    setup({ save: vi.fn(async () => { throw new Error("Incorrect PIN"); }) });
    await screen.findByLabelText(/model provider/i);
    await userEvent.click(screen.getByLabelText(/also speak/i));
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await typePin("000000");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/incorrect pin/i);
    expect(screen.getByRole("button", { name: /^save$/i })).toHaveProperty("disabled", true); // PIN was cleared
  });

  it("tells the owner which changes need a restart", async () => {
    setup({ save: vi.fn(async () => ({ settings: view, changed: true, restart: ["voice.ttsVoice"] })) });
    await screen.findByLabelText(/model provider/i);
    await userEvent.clear(screen.getByLabelText(/speaking voice/i));
    await userEvent.type(screen.getByLabelText(/speaking voice/i), "en_US-amy-medium");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect((await screen.findByText(/restart friend/i)).textContent).toMatch(/voice/i);
  });

  it("never shows the saved API key, only that one exists", async () => {
    setup({}, { ...view, provider: "claude", apiKeySet: true });
    const key = (await screen.findByLabelText(/^api key/i)) as HTMLInputElement;
    expect(key.value).toBe("");
    expect(key.placeholder).toBe("saved");
    expect(key.type).toBe("password");
  });

  it("reports a load failure and can be closed", async () => {
    const { onClose } = setup({ get: vi.fn(async () => { throw new Error("Please sign in again."); }) });
    expect((await screen.findByRole("alert")).textContent).toMatch(/sign in/i);
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("diffSettings", () => {
  it("is empty when nothing changed and carries a typed API key", () => {
    expect(diffSettings(view, structuredClone(view), "")).toEqual({});
    expect(diffSettings(view, structuredClone(view), "  sk-new ")).toEqual({ apiKey: "sk-new" });
  });
  it("turns an emptied language into an empty string, which means automatic", () => {
    const after = structuredClone(view);
    after.voice.language = "hi";
    expect(diffSettings(view, after, "")).toEqual({ voice: { language: "hi" } });
    expect(diffSettings(after, view, "")).toEqual({ voice: { language: "" } });
  });
});

describe("owner menu", () => {
  it("has a Settings entry that opens it and closes the menu", async () => {
    const onSettings = vi.fn();
    render(<OwnerMenu muted={false} onToggleMute={() => {}} onSignedOut={() => {}} onSettings={onSettings} />);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    expect(onSettings).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /owner menu/i })).toBeNull();
  });
});
