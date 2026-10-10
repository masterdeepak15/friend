import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "./SettingsPanel";
import { DEFAULT_LOOK, diffSettings, needsPin, type SettingsApi, type SettingsView } from "./settingsApi";

afterEach(cleanup);

const view: SettingsView = {
  provider: "claude-code",
  model: "claude-sonnet-5-5",
  apiKeySet: false,
  view: "companion",
  approvals: "manual",
  look: { ...DEFAULT_LOOK },
  ollama: { url: "http://127.0.0.1:11434", model: "qwen2.5:7b", vision: false, contextTokens: 8192 },
  claudeCode: { model: "sonnet", command: "claude", fallback: "ollama" },
  voice: { enabled: true, speakTyped: true, language: null, accept: 0.72, challenge: 0.58, ttsVoice: "en_US-lessac-medium", sttModel: "base" },
};

function setup() {
  const api: SettingsApi = {
    get: vi.fn(async () => view),
    save: vi.fn(async () => ({ settings: { ...view, approvals: "auto" as const }, changed: true, restart: [] })),
  };
  render(<SettingsPanel api={api} onClose={() => {}} initialTab="approvals" />);
  return api;
}

describe("the approvals tab", () => {
  it("offers the three modes, with the current one chosen", async () => {
    setup();
    const manual = (await screen.findByRole("radio", { name: /Ask me/ })) as HTMLInputElement;
    expect(manual.checked).toBe(true);
    expect(screen.getByRole("radio", { name: /file work/ })).toBeTruthy();
    expect(screen.getByRole("radio", { name: /everything safe/ })).toBeTruthy();
    expect(screen.getByText(/these still ask: risky commands/)).toBeTruthy();
  });

  it("saves a change only after the PIN, because it loosens safety", async () => {
    const api = setup();
    await userEvent.click(await screen.findByRole("radio", { name: /everything safe/ }));
    await userEvent.click(screen.getByRole("button", { name: /Save/ }));
    expect(await screen.findByText(/Enter your PIN/)).toBeTruthy();
    for (const d of "123456") await userEvent.click(screen.getByRole("button", { name: d }));
    await userEvent.click(screen.getByRole("button", { name: /Save|Confirm|OK/ }));
    expect(api.save).toHaveBeenCalledWith({ approvals: "auto" }, "123456");
  });
});

describe("approvals in the change list", () => {
  it("sends only a real change, and treats a missing value as manual", () => {
    expect(diffSettings(view, { ...view, approvals: "edits" }, "")).toEqual({ approvals: "edits" });
    expect(diffSettings(view, { ...view }, "")).toEqual({});
    const { approvals: _a, ...old } = view;
    expect(diffSettings(old, { ...old, approvals: "manual" }, "")).toEqual({});
  });
  it("needs the PIN", () => {
    expect(needsPin({ approvals: "auto" })).toBe(true);
  });
});
