import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerMenu } from "../overlay/OwnerMenu";
import { SettingsPanel, type SettingsTab } from "./SettingsPanel";
import { DEFAULT_LOOK, diffSettings, needsPin, type SettingsApi, type SettingsView } from "./settingsApi";
import { THEMES, isTheme } from "./themes";

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

function setup(overrides: Partial<SettingsApi> = {}, start: SettingsView = view, tab: SettingsTab = "model", preview: (voice: string) => Promise<void> = async () => {}) {
  const api: SettingsApi = {
    get: vi.fn(async () => start),
    save: vi.fn(async () => ({ settings: start, changed: true, restart: [] })),
    ...overrides,
  };
  const onClose = vi.fn();
  render(<SettingsPanel api={api} onClose={onClose} initialTab={tab} preview={preview} />);
  return { api, onClose };
}
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const openTab = async (name: RegExp) => userEvent.click(await screen.findByRole("tab", { name }));

describe("the tabs", () => {
  it("are Model, Voice and Voice presence, and open on the one asked for", async () => {
    setup();
    const tabs = (await screen.findAllByRole("tab")).map((t) => t.textContent);
    expect(tabs[0]).toMatch(/Model/);
    expect(tabs[1]).toMatch(/Voice/);
    expect(tabs[2]).toMatch(/Voice presence/);
    expect(screen.getByRole("tab", { name: /Model/ }).getAttribute("aria-selected")).toBe("true");
    cleanup();
    setup({}, view, "look");
    expect((await screen.findByRole("tab", { name: /Voice presence/ })).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("group", { name: "Themes" })).toBeTruthy();
  });

  it("show only their own settings", async () => {
    setup();
    expect(await screen.findByLabelText(/model provider/i)).toBeTruthy();
    expect(screen.queryByLabelText(/speaking voice/i)).toBeNull();
    await openTab(/^Voice\s*Speaking/);
    expect(screen.getByLabelText(/speaking voice/i)).toBeTruthy();
    expect(screen.queryByLabelText(/model provider/i)).toBeNull();
  });

  it("move with the arrow keys", async () => {
    setup();
    const first = await screen.findByRole("tab", { name: /Model/ });
    first.focus();
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("tab", { name: /^Voice\s*Speaking/ }).getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{End}");
    expect(screen.getByRole("tab", { name: /Security/ }).getAttribute("aria-selected")).toBe("true");
    await userEvent.keyboard("{ArrowDown}");
    expect(screen.getByRole("tab", { name: /Model/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("keep what was changed on another tab while looking around", async () => {
    setup();
    await userEvent.selectOptions(await screen.findByLabelText(/model provider/i), "ollama");
    await openTab(/Voice presence/);
    await openTab(/Model/);
    expect(screen.getByLabelText(/model provider/i)).toHaveProperty("value", "ollama");
  });
});

describe("the model tab", () => {
  it("shows the current choice and only the fields that belong to it", async () => {
    setup();
    expect(await screen.findByLabelText(/model provider/i)).toHaveProperty("value", "claude-code");
    expect(screen.getByLabelText(/claude model/i)).toHaveProperty("value", "sonnet");
    expect(screen.queryByLabelText(/^api key/i)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText(/model provider/i), "claude");
    expect(screen.getByLabelText(/^api key/i)).toBeTruthy();
    expect(screen.queryByLabelText(/claude code command/i)).toBeNull();
  });

  it("asks for the PIN, sends only what changed, and says it is in use", async () => {
    const saved: SettingsView = { ...view, claudeCode: { ...view.claudeCode, model: "haiku" } };
    const { api } = setup({ save: vi.fn(async () => ({ settings: saved, changed: true, restart: [] })) });
    await userEvent.clear(await screen.findByLabelText(/claude model/i));
    await userEvent.type(screen.getByLabelText(/claude model/i), "haiku");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(screen.getByText(/enter your pin/i)).toBeTruthy();
    expect(api.save).not.toHaveBeenCalled();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ claudeCode: { model: "haiku" } }, "123456"));
    expect(await screen.findByText(/in use now/i)).toBeTruthy();
  });

  it("cannot be saved until something changes", async () => {
    setup();
    await screen.findByLabelText(/model provider/i);
    expect(screen.getByRole("button", { name: /save/i })).toHaveProperty("disabled", true);
    await userEvent.clear(screen.getByLabelText(/claude model/i));
    await userEvent.type(screen.getByLabelText(/claude model/i), "haiku");
    expect(screen.getByRole("button", { name: /save/i })).toHaveProperty("disabled", false);
  });

  it("never shows the saved API key, only that one exists", async () => {
    setup({}, { ...view, provider: "claude", apiKeySet: true });
    const key = (await screen.findByLabelText(/^api key/i)) as HTMLInputElement;
    expect(key.value).toBe("");
    expect(key.placeholder).toBe("saved");
    expect(key.type).toBe("password");
  });

  it("shows a wrong PIN, stays on the PIN page, and clears the PIN", async () => {
    setup({
      save: vi.fn(async () => {
        throw new Error("Incorrect PIN");
      }),
    });
    await userEvent.selectOptions(await screen.findByLabelText(/model provider/i), "ollama");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await typePin("000000");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/incorrect pin/i);
    expect(screen.getByRole("button", { name: /^save$/i })).toHaveProperty("disabled", true);
  });

  it("reports a load failure and can be closed", async () => {
    const { onClose } = setup({
      get: vi.fn(async () => {
        throw new Error("Please sign in again.");
      }),
    });
    expect((await screen.findByRole("alert")).textContent).toMatch(/sign in/i);
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("the voice tab", () => {
  const voiceTab = () => openTab(/^Voice\s*Speaking/);

  it("tells which changes need a restart (the listening model does, the speaking voice does not)", async () => {
    setup({ save: vi.fn(async () => ({ settings: view, changed: true, restart: ["voice.sttModel"] })) });
    await voiceTab();
    await userEvent.clear(screen.getByLabelText(/listening model/i));
    await userEvent.type(screen.getByLabelText(/listening model/i), "small");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect((await screen.findByText(/restart friend/i)).textContent).toMatch(/listening model/i);
  });

  it("offers female and male voices in groups, with the current one selected", async () => {
    setup();
    await voiceTab();
    const select = screen.getByLabelText(/speaking voice/i) as HTMLSelectElement;
    const groups = Array.from(select.querySelectorAll("optgroup")).map((g) => g.label);
    expect(groups).toEqual(["Female", "Male", "Original"]);
    const female = within(select.querySelector('optgroup[label="Female"]') as HTMLElement).getAllByRole("option").map((o) => o.textContent);
    const male = within(select.querySelector('optgroup[label="Male"]') as HTMLElement).getAllByRole("option").map((o) => o.textContent);
    expect(female.length).toBeGreaterThanOrEqual(5);
    expect(male.length).toBeGreaterThanOrEqual(5);
    expect(female[0]).toMatch(/Amy · American/);
    expect(male[0]).toMatch(/Ryan · American/);
    expect(select.value).toBe("en_US-lessac-medium");
  });

  it("saves a chosen voice (with the PIN) and says it is loading, not that a restart is needed", async () => {
    const saved: SettingsView = { ...view, voice: { ...view.voice, ttsVoice: "en_US-amy-medium" } };
    const { api } = setup({ save: vi.fn(async () => ({ settings: saved, changed: true, restart: [] })) });
    await voiceTab();
    await userEvent.selectOptions(screen.getByLabelText(/speaking voice/i), "en_US-amy-medium");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ voice: { ttsVoice: "en_US-amy-medium" } }, "123456"));
    const note = await screen.findByText(/new voice is loading/i);
    expect(note.textContent).toMatch(/60 MB/);
    expect(note.textContent).not.toMatch(/restart/i);
  });

  it("plays the voice that is chosen, before it is saved, and shows what happens", async () => {
    const preview = vi.fn(async () => {});
    const { api } = setup({}, view, "model", preview);
    await voiceTab();
    await userEvent.selectOptions(screen.getByLabelText(/speaking voice/i), "en_GB-jenny_dioco-medium");
    await userEvent.click(screen.getByRole("button", { name: "Hear it" }));
    await waitFor(() => expect(preview).toHaveBeenCalledWith("en_GB-jenny_dioco-medium"));
    expect(await screen.findByText("Playing…")).toBeTruthy();
    expect(api.save).not.toHaveBeenCalled();
  });

  it("says why a voice could not be played, and can be tried again", async () => {
    const preview = vi.fn(async () => {
      throw new Error("Could not play that voice. The first time it needs internet.");
    });
    setup({}, view, "model", preview);
    await voiceTab();
    await userEvent.click(screen.getByRole("button", { name: "Hear it" }));
    expect(await screen.findByText(/needs internet/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hear it" })).toHaveProperty("disabled", false);
  });

  it("lets you hear the Hindi and the Marathi voice, each by itself, with the voice it names", async () => {
    const withIndian: SettingsView = { ...view, voice: { ...view.voice, hindiVoice: "hi_IN-priyamvada-medium", marathiVoice: "mr_IN-google-medium" } };
    const preview = vi.fn(async () => {});
    setup({}, withIndian, "model", preview);
    await voiceTab();
    await userEvent.click(screen.getByRole("button", { name: "Hear the Hindi voice" }));
    await waitFor(() => expect(preview).toHaveBeenCalledWith("hi_IN-priyamvada-medium"));
    await userEvent.click(await screen.findByRole("button", { name: "Hear the Marathi voice" }));
    await waitFor(() => expect(preview).toHaveBeenCalledWith("mr_IN-google-medium"));
    expect(preview).toHaveBeenCalledTimes(2);
  });

  it("warns that the first listen downloads the voice", async () => {
    const withIndian: SettingsView = { ...view, voice: { ...view.voice, hindiVoice: "hi_IN-rohan-medium" } };
    const preview = vi.fn(() => new Promise<void>(() => {}));
    setup({}, withIndian, "model", preview);
    await voiceTab();
    await userEvent.click(screen.getByRole("button", { name: "Hear the Hindi voice" }));
    expect(await screen.findByText(/downloads \(about 64 MB\)/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Hear it" })).toHaveProperty("disabled", true); // one voice at a time
  });

  it("can not play a Hindi or Marathi voice that is set to 'same as the voice above'", async () => {
    setup();
    await voiceTab();
    expect(screen.getByRole("button", { name: "Hear the Hindi voice" })).toHaveProperty("disabled", true);
    expect(screen.getByRole("button", { name: "Hear the Marathi voice" })).toHaveProperty("disabled", true);
  });

  it("keeps a voice that is not in the list, so it is not lost when the settings are opened", async () => {
    const custom: SettingsView = { ...view, voice: { ...view.voice, ttsVoice: "hi_IN-pratham-medium" } };
    setup({}, custom);
    await voiceTab();
    const select = screen.getByLabelText(/speaking voice/i) as HTMLSelectElement;
    expect(select.value).toBe("hi_IN-pratham-medium");
    expect(select.querySelector('optgroup[label="Other"]')).toBeTruthy();
    expect(screen.getByRole("button", { name: /save/i })).toHaveProperty("disabled", true); // nothing changed
  });
});

describe("the voice presence tab", () => {
  const look = async () => {
    const r = setup({}, view, "look");
    await screen.findByRole("group", { name: "Themes" });
    return r;
  };

  it("has a live preview, themes, shape, colour, light and caption choices", async () => {
    await look();
    expect(screen.getByTestId("look-preview")).toBeTruthy();
    expect(within(screen.getByRole("group", { name: "Themes" })).getAllByRole("button")).toHaveLength(THEMES.length);
    expect(within(screen.getByRole("radiogroup", { name: "Style" })).getAllByRole("radio")).toHaveLength(3);
    expect(screen.getByLabelText(/^Brightness/)).toBeTruthy();
    expect(screen.getByLabelText(/^Size/)).toBeTruthy();
    expect(screen.getByLabelText(/^Reaction to my voice/)).toBeTruthy();
    expect(screen.getByLabelText(/Soft glow/)).toBeTruthy();
    expect(screen.getByLabelText(/Show the live words/)).toBeTruthy();
    expect(screen.getByLabelText(/Caption size/)).toBeTruthy();
    expect(screen.getByLabelText(/^View/)).toBeTruthy();
    expect(screen.getByLabelText(/Let the AI change/)).toBeTruthy();
  });

  it("marks the theme that is in use, and one click sets its style, colour and brightness", async () => {
    const { api } = await look();
    expect(screen.getByRole("button", { name: /Aurora/ }).getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: /Ember/ }));
    expect(screen.getByRole("button", { name: /Ember/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("radio", { name: /Orb/ }).getAttribute("aria-checked")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ look: { style: "orb", accent: "#ff9b3d", intensity: 0.7 } }, undefined));
  });

  it("saves a change of look WITHOUT asking for the PIN, and says every screen has changed", async () => {
    const saved: SettingsView = { ...view, look: { ...view.look, size: 1.3 } };
    const { api } = setup({ save: vi.fn(async () => ({ settings: saved, changed: true, restart: [] })) }, view, "look");
    const size = (await screen.findByLabelText(/^Size/)) as HTMLInputElement;
    fireEvent.change(size, { target: { value: "1.3" } });
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    expect(screen.queryByText(/enter your pin/i)).toBeNull();
    await waitFor(() => expect(api.save).toHaveBeenCalledTimes(1));
    expect((api.save as ReturnType<typeof vi.fn>).mock.calls[0]![1]).toBeUndefined();
    expect(await screen.findByText(/every open screen has changed/i)).toBeTruthy();
  });

  it("asks for the PIN as soon as a safety-relevant setting is changed along with it", async () => {
    const { api } = setup({}, view, "look");
    await userEvent.click(await screen.findByRole("button", { name: /Ember/ }));
    await openTab(/Model/);
    await userEvent.selectOptions(screen.getByLabelText(/model provider/i), "ollama");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    expect(screen.getByText(/enter your pin/i)).toBeTruthy();
    expect(api.save).not.toHaveBeenCalled();
  });

  it("changes the preview as choices are made, before anything is saved", async () => {
    const { api } = await look();
    await userEvent.click(screen.getByRole("radio", { name: /Ring/ }));
    expect(screen.getByRole("radio", { name: /Ring/ }).getAttribute("aria-checked")).toBe("true");
    expect(document.querySelector('[data-presence][data-style="ring"]')).toBeTruthy();
    await userEvent.click(screen.getByLabelText(/Show the live words/));
    expect(screen.queryByText(/how my words will look/i)).toBeNull();
    expect(api.save).not.toHaveBeenCalled();
  });

  it("picks a colour from the swatches", async () => {
    const { api } = await look();
    await userEvent.click(screen.getByRole("button", { name: "Colour #ff6fae" }));
    expect(screen.getByRole("button", { name: "Colour #ff6fae" }).getAttribute("aria-pressed")).toBe("true");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ look: { accent: "#ff6fae" } }, undefined));
  });

  it("turns the caption size off when captions are off, and keeps the AI switch", async () => {
    await look();
    await userEvent.click(screen.getByLabelText(/Show the live words/));
    expect(screen.getByLabelText(/Caption size/)).toHaveProperty("disabled", true);
    await userEvent.click(screen.getByLabelText(/Let the AI change/));
    expect((screen.getByLabelText(/Let the AI change/) as HTMLInputElement).checked).toBe(false);
  });

  it("goes back to the default look, and undoes changes", async () => {
    const custom: SettingsView = { ...view, look: { ...view.look, style: "ring", accent: "#ff6fae", size: 0.7 } };
    const { api } = setup({}, custom, "look");
    await userEvent.click(await screen.findByRole("button", { name: /Back to the default look/ }));
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ look: { style: "sphere", accent: "#3fd8ff", size: 1 } }, undefined));
    cleanup();
    setup({}, view, "look");
    await userEvent.click(await screen.findByRole("button", { name: /Ember/ }));
    await userEvent.click(screen.getByRole("button", { name: /Undo changes/ }));
    expect(screen.getByRole("button", { name: /Aurora/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: /^Save/ })).toHaveProperty("disabled", true);
  });

  it("lets the owner choose the view and sends just that, without the PIN", async () => {
    const { api } = await look();
    await userEvent.selectOptions(screen.getByLabelText(/^View/), "workspace");
    await userEvent.click(screen.getByRole("button", { name: /^Save$/ }));
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ view: "workspace" }, undefined));
  });
});

describe("themes and the patch", () => {
  it("knows which theme a look is", () => {
    expect(isTheme(DEFAULT_LOOK, THEMES[0]!)).toBe(true);
    expect(isTheme({ ...DEFAULT_LOOK, accent: "#3FD8FF" }, THEMES[0]!)).toBe(true);
    expect(isTheme({ ...DEFAULT_LOOK, intensity: 0.9 }, THEMES[0]!)).toBe(false);
  });
  it("every theme is a valid look the server accepts", () => {
    for (const t of THEMES) {
      expect(t.accent).toMatch(/^#[0-9a-f]{6}$/);
      expect(["sphere", "orb", "ring"]).toContain(t.style);
      expect(t.intensity).toBeGreaterThanOrEqual(0);
      expect(t.intensity).toBeLessThanOrEqual(1);
    }
    expect(new Set(THEMES.map((t) => t.id)).size).toBe(THEMES.length);
  });
  it("diffSettings is empty when nothing changed and names only the changed look fields", () => {
    expect(diffSettings(view, structuredClone(view), "")).toEqual({});
    const after = structuredClone(view);
    after.look.accent = "#ff0000";
    after.look.captions = false;
    expect(diffSettings(view, after, "")).toEqual({ look: { accent: "#ff0000", captions: false } });
  });
  it("only the look and the view are free of the PIN", () => {
    expect(needsPin({ look: { size: 1 } })).toBe(false);
    expect(needsPin({ view: "minimal", look: {} })).toBe(false);
    expect(needsPin({ look: {}, provider: "ollama" })).toBe(true);
    expect(needsPin({ apiKey: "x" })).toBe(true);
    expect(needsPin({ voice: { speakTyped: false } })).toBe(true);
  });
  it("turns an emptied language into an empty string, which means automatic", () => {
    const after = structuredClone(view);
    after.voice.language = "hi";
    expect(diffSettings(view, after, "")).toEqual({ voice: { language: "hi" } });
    expect(diffSettings(after, view, "")).toEqual({ voice: { language: "" } });
  });
  it("sends a typed API key", () => {
    expect(diffSettings(view, structuredClone(view), "  sk-new ")).toEqual({ apiKey: "sk-new" });
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

  it("cycles the view between companion and workspace, never walks into minimal, and minimal gets out to companion", async () => {
    const cases: [string, string][] = [
      ["companion", "workspace"],
      ["workspace", "companion"],
      ["minimal", "companion"],
    ];
    for (const [from, to] of cases) {
      const onView = vi.fn();
      const { unmount } = render(<OwnerMenu muted={false} onToggleMute={() => {}} onSignedOut={() => {}} view={from as "minimal"} onView={onView} />);
      await userEvent.keyboard("{Escape}");
      await userEvent.click(screen.getByRole("button", { name: `View: ${from}` }));
      expect(onView, from).toHaveBeenCalledWith(to);
      unmount();
    }
  });
});
