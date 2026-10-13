import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
  look: { ...DEFAULT_LOOK },
  ollama: { url: "http://127.0.0.1:11434", model: "qwen2.5:7b", vision: false, contextTokens: 8192 },
  claudeCode: { model: "sonnet", command: "claude", fallback: "ollama", webSearch: true },
  voice: { enabled: true, speakTyped: true, language: null, accept: 0.72, challenge: 0.58, ttsVoice: "en_US-lessac-medium", sttModel: "base" },
  web: { enabled: true, provider: "duckduckgo", searxngUrl: "", braveKeySet: false, tavilyKeySet: false },
};
const withWeb = (w: Partial<NonNullable<SettingsView["web"]>>): SettingsView => ({ ...view, web: { ...view.web!, ...w } });

function setup(start: SettingsView = view) {
  const api: SettingsApi = { get: vi.fn(async () => start), save: vi.fn(async () => ({ settings: start, changed: true, restart: [] })) };
  render(<SettingsPanel api={api} onClose={vi.fn()} initialTab="model" preview={async () => {}} />);
  return api;
}
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const saveWithPin = async () => {
  await userEvent.click(screen.getByRole("button", { name: /save/i }));
  await typePin("123456");
  await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
};

describe("what changed in the web search settings", () => {
  it("sends nothing when nothing changed", () => {
    expect(diffSettings(view, view, "")).toEqual({});
  });

  it("sends only the setting that changed", () => {
    expect(diffSettings(view, withWeb({ provider: "brave" }), "")).toEqual({ web: { provider: "brave" } });
    expect(diffSettings(view, withWeb({ enabled: false }), "")).toEqual({ web: { enabled: false } });
    expect(diffSettings(view, withWeb({ searxngUrl: "http://localhost:8080" }), "")).toEqual({ web: { searxngUrl: "http://localhost:8080" } });
  });

  it("sends a key only when one was typed", () => {
    expect(diffSettings(view, view, "", "", { brave: "BK", tavily: "" })).toEqual({ web: { braveKey: "BK" } });
    expect(diffSettings(view, view, "", "", { brave: "  ", tavily: " TK " })).toEqual({ web: { tavilyKey: "TK" } });
    expect(diffSettings(view, withWeb({ provider: "tavily" }), "", "", { brave: "", tavily: "TK" })).toEqual({ web: { provider: "tavily", tavilyKey: "TK" } });
  });

  it("needs the PIN, like the other settings that matter", () => {
    expect(needsPin({ web: { provider: "brave" } })).toBe(true);
  });
});

describe("the web search block in Settings, Model", () => {
  it("offers DuckDuckGo first, with no key asked for", async () => {
    setup();
    expect(await screen.findByLabelText(/let friend search the web/i)).toHaveProperty("checked", true);
    const source = screen.getByLabelText(/search source/i) as HTMLSelectElement;
    expect(source.value).toBe("duckduckgo");
    expect(screen.queryByLabelText(/brave key/i)).toBeNull();
    expect(screen.queryByLabelText(/searxng address/i)).toBeNull();
  });

  it("asks for the key of the source that was picked, and saves it without ever showing it", async () => {
    const api = setup();
    await userEvent.selectOptions(await screen.findByLabelText(/search source/i), "brave");
    const key = screen.getByLabelText(/brave key/i) as HTMLInputElement;
    expect(key.type).toBe("password");
    await userEvent.type(key, "BRAVE-KEY-1");
    await saveWithPin();
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ web: { provider: "brave", braveKey: "BRAVE-KEY-1" } }, "123456"));
  });

  it("says a key is saved without showing it, and leaves it alone unless a new one is typed", async () => {
    setup(withWeb({ provider: "tavily", tavilyKeySet: true }));
    const key = (await screen.findByLabelText(/tavily key/i)) as HTMLInputElement;
    expect(key.value).toBe("");
    expect(key.placeholder).toBe("saved");
    expect(screen.getByRole("button", { name: /save/i })).toHaveProperty("disabled", true);
  });

  it("asks for the address of your own SearXNG server", async () => {
    const api = setup();
    await userEvent.selectOptions(await screen.findByLabelText(/search source/i), "searxng");
    await userEvent.type(screen.getByLabelText(/searxng address/i), "http://localhost:8080");
    await saveWithPin();
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ web: { provider: "searxng", searxngUrl: "http://localhost:8080" } }, "123456"));
  });

  it("switches searching off", async () => {
    const api = setup();
    await userEvent.click(await screen.findByLabelText(/let friend search the web/i));
    await saveWithPin();
    await waitFor(() => expect(api.save).toHaveBeenCalledWith({ web: { enabled: false } }, "123456"));
  });

  it("says what the tools do and that pages are untrusted", async () => {
    setup();
    expect(await screen.findByText(/web\.search/)).toBeTruthy();
    expect(screen.getByText(/never take orders from a page/i)).toBeTruthy();
  });
});
