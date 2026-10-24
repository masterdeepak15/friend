import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryTab } from "./MemoryTab";
import { SettingsPanel } from "./SettingsPanel";
import { DEFAULT_LOOK, diffSettings, type MemorySettings, type SettingsApi, type SettingsView } from "./settingsApi";

afterEach(cleanup);

const base = (over: Partial<MemorySettings> = {}): MemorySettings => ({ enabled: true, autoSave: "on", showSaved: true, saveDelaySec: 120, maxIndexChars: 1500, ...over });

function mount(over: Partial<MemorySettings> = {}) {
  const onChange = vi.fn();
  render(<MemoryTab memory={base(over)} onChange={onChange} />);
  return { onChange };
}
const typeInto = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("the Memory tab", () => {
  it("each control sends exactly its own change", () => {
    const { onChange } = mount();
    fireEvent.click(screen.getByRole("checkbox", { name: /keep memory as a tree of notes/i }));
    expect(onChange).toHaveBeenLastCalledWith({ enabled: false });
    fireEvent.click(screen.getByRole("checkbox", { name: /save what is worth keeping, by itself/i }));
    expect(onChange).toHaveBeenLastCalledWith({ autoSave: "off" });
    fireEvent.click(screen.getByRole("checkbox", { name: /tell me what was remembered/i }));
    expect(onChange).toHaveBeenLastCalledWith({ showSaved: false });
    typeInto(/wait after i stop talking/i, "300");
    expect(onChange).toHaveBeenLastCalledWith({ saveDelaySec: 300 });
    typeInto(/index size/i, "2500");
    expect(onChange).toHaveBeenLastCalledWith({ maxIndexChars: 2500 });
  });

  it("turning saving on from off sends 'on'", () => {
    const { onChange } = mount({ autoSave: "off" });
    fireEvent.click(screen.getByRole("checkbox", { name: /save what is worth keeping, by itself/i }));
    expect(onChange).toHaveBeenLastCalledWith({ autoSave: "on" });
  });

  it("leaves the rest alone when memory is off, or saving is off", () => {
    mount({ enabled: false });
    for (const label of [/save what is worth keeping/i, /tell me what was remembered/i, /wait after i stop/i, /index size/i]) expect((screen.getByLabelText(label) as HTMLInputElement).disabled).toBe(true);
    cleanup();
    mount({ autoSave: "off" });
    expect((screen.getByLabelText(/tell me what was remembered/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/wait after i stop/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByLabelText(/index size/i) as HTMLInputElement).disabled).toBe(false);
  });

  it("says where the notes are and how to see them", () => {
    mount();
    expect(screen.getByText(/friend memory list/i)).toBeTruthy();
  });
});

describe("saving memory settings", () => {
  const view = (memory?: MemorySettings): SettingsView => ({
    provider: "claude-code",
    model: "claude-sonnet-5-5",
    apiKeySet: false,
    view: "companion",
    look: { ...DEFAULT_LOOK },
    ollama: { url: "http://127.0.0.1:11434", model: "qwen2.5:7b", vision: false, contextTokens: 8192 },
    claudeCode: { model: "sonnet", command: "claude", fallback: "ollama" },
    voice: { enabled: true, speakTyped: true, language: null, accept: 0.72, challenge: 0.58, ttsVoice: "en_US-lessac-medium", sttModel: "base" },
    ...(memory ? { memory } : {}),
  });
  const apiOf = (v: SettingsView): SettingsApi => ({ get: async () => v, save: vi.fn(async () => ({ settings: v, changed: true, restart: [] })) });

  it("sends only what changed, and asks for the PIN", async () => {
    const api = apiOf(view(base()));
    render(<SettingsPanel api={api} onClose={() => {}} initialTab="memory" />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /save what is worth keeping, by itself/i }));
    fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    expect(await screen.findByText(/enter your pin/i)).toBeTruthy();
    expect(diffSettings(view(base()), view(base({ autoSave: "off" })), "")).toEqual({ memory: { autoSave: "off" } });
  });

  it("cannot be saved with a delay or an index size out of range", async () => {
    render(<SettingsPanel api={apiOf(view(base()))} onClose={() => {}} initialTab="memory" />);
    fireEvent.change(await screen.findByLabelText(/wait after i stop talking/i), { target: { value: "5" } });
    expect((screen.getByRole("button", { name: /^save/i }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText(/wait after i stop talking/i), { target: { value: "60" } });
    expect((screen.getByRole("button", { name: /^save/i }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.change(screen.getByLabelText(/index size/i), { target: { value: "9000" } });
    expect((screen.getByRole("button", { name: /^save/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows no tab body when the settings carry no memory section", async () => {
    render(<SettingsPanel api={apiOf(view())} onClose={() => {}} initialTab="memory" />);
    await screen.findByRole("tab", { name: /^memory/i });
    expect(screen.queryByRole("checkbox", { name: /keep memory as a tree/i })).toBeNull();
  });
});
