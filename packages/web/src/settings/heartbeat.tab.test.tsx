import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HeartbeatTab, heartbeatBad } from "./HeartbeatTab";
import { SettingsPanel } from "./SettingsPanel";
import { DEFAULT_LOOK, diffSettings, type ProactiveSettings, type SettingsApi, type SettingsView } from "./settingsApi";

afterEach(cleanup);

const base = (over: Partial<ProactiveSettings> = {}): ProactiveSettings => ({ level: "medium", quietFrom: "22:00", quietTo: "07:00", morningAt: "08:00", eveningAt: "20:30", dailyCap: 6, minGapMin: 30, silenceHours: 8, speak: false, phone: true, ...over });

function mount(over: Partial<ProactiveSettings> = {}) {
  const onChange = vi.fn();
  render(<HeartbeatTab proactive={base(over)} onChange={onChange} />);
  return { onChange };
}

describe("the Heartbeat tab", () => {
  it("shows the four levels with the saved one chosen, and sends exactly the level picked", () => {
    const { onChange } = mount({ level: "low" });
    const radio = (name: RegExp) => screen.getByRole("radio", { name }) as HTMLInputElement;
    expect(radio(/^low/i).checked).toBe(true);
    fireEvent.click(radio(/^high/i));
    expect(onChange).toHaveBeenLastCalledWith({ level: "high" });
    fireEvent.click(radio(/^off/i));
    expect(onChange).toHaveBeenLastCalledWith({ level: "off" });
  });

  it("each time, number and switch sends only its own change", () => {
    const { onChange } = mount({ level: "high" });
    fireEvent.change(screen.getByLabelText(/quiet from/i), { target: { value: "23:15" } });
    expect(onChange).toHaveBeenLastCalledWith({ quietFrom: "23:15" });
    fireEvent.change(screen.getByLabelText(/quiet until/i), { target: { value: "06:30" } });
    expect(onChange).toHaveBeenLastCalledWith({ quietTo: "06:30" });
    fireEvent.change(screen.getByLabelText(/^morning check-in from/i), { target: { value: "09:00" } });
    expect(onChange).toHaveBeenLastCalledWith({ morningAt: "09:00" });
    fireEvent.change(screen.getByLabelText(/^evening check-in from/i), { target: { value: "21:00" } });
    expect(onChange).toHaveBeenLastCalledWith({ eveningAt: "21:00" });
    fireEvent.change(screen.getByLabelText(/most contacts/i), { target: { value: "3" } });
    expect(onChange).toHaveBeenLastCalledWith({ dailyCap: 3 });
    fireEvent.change(screen.getByLabelText(/least minutes/i), { target: { value: "60" } });
    expect(onChange).toHaveBeenLastCalledWith({ minGapMin: 60 });
    fireEvent.change(screen.getByLabelText(/hours of silence/i), { target: { value: "12" } });
    expect(onChange).toHaveBeenLastCalledWith({ silenceHours: 12 });
    fireEvent.click(screen.getByRole("checkbox", { name: /say it aloud/i }));
    expect(onChange).toHaveBeenLastCalledWith({ speak: true });
    fireEvent.click(screen.getByRole("checkbox", { name: /message my phone/i }));
    expect(onChange).toHaveBeenLastCalledWith({ phone: false });
  });

  it("leaves everything else alone while it is off, and the silence hours for the high level only", () => {
    mount({ level: "off" });
    for (const label of [/quiet from/i, /most contacts/i, /say it aloud/i, /message my phone/i]) expect((screen.getByLabelText(label) as HTMLInputElement).disabled).toBe(true);
    cleanup();
    mount({ level: "medium" });
    expect((screen.getByLabelText(/hours of silence/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/most contacts/i) as HTMLInputElement).disabled).toBe(false);
  });

  it("says what each level does, and that the model can only choose words", () => {
    mount();
    expect(screen.getByText(/gentle check-in when you have been silent/i)).toBeTruthy();
    expect(screen.getByText(/it cannot run tools or change anything/i)).toBeTruthy();
  });

  it("flags a number outside what is allowed", () => {
    expect(heartbeatBad(base())).toBe(false);
    for (const bad of [{ dailyCap: 0 }, { dailyCap: 21 }, { minGapMin: 4 }, { minGapMin: 721 }, { silenceHours: 1 }, { silenceHours: 73 }]) expect(heartbeatBad(base(bad)), JSON.stringify(bad)).toBe(true);
  });
});

describe("saving heartbeat settings", () => {
  const view = (proactive?: ProactiveSettings): SettingsView => ({
    provider: "claude-code",
    model: "claude-sonnet-5-5",
    apiKeySet: false,
    view: "companion",
    look: { ...DEFAULT_LOOK },
    ollama: { url: "http://127.0.0.1:11434", model: "qwen2.5:7b", vision: false, contextTokens: 8192 },
    claudeCode: { model: "sonnet", command: "claude", fallback: "ollama" },
    voice: { enabled: true, speakTyped: true, language: null, accept: 0.72, challenge: 0.58, ttsVoice: "en_US-lessac-medium", sttModel: "base" },
    ...(proactive ? { proactive } : {}),
  });
  const apiOf = (v: SettingsView): SettingsApi => ({ get: async () => v, save: vi.fn(async () => ({ settings: v, changed: true, restart: [] })) });

  it("sends only what changed, and asks for the PIN", async () => {
    render(<SettingsPanel api={apiOf(view(base({ level: "off" })))} onClose={() => {}} initialTab="heartbeat" />);
    fireEvent.click(await screen.findByRole("radio", { name: /^medium/i }));
    fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    expect(await screen.findByText(/enter your pin/i)).toBeTruthy();
    expect(diffSettings(view(base({ level: "off" })), view(base({ level: "medium" })), "")).toEqual({ proactive: { level: "medium" } });
  });

  it("cannot be saved with a number out of range", async () => {
    render(<SettingsPanel api={apiOf(view(base()))} onClose={() => {}} initialTab="heartbeat" />);
    fireEvent.change(await screen.findByLabelText(/most contacts/i), { target: { value: "50" } });
    expect((screen.getByRole("button", { name: /^save/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/most contacts/i), { target: { value: "5" } });
    expect((screen.getByRole("button", { name: /^save/i }) as HTMLButtonElement).disabled).toBe(false);
  });
});
