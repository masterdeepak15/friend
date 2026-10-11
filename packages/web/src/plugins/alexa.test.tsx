import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_LOOK, type SettingsApi, type SettingsView } from "../settings/settingsApi";
import type { AlexaApi, AlexaStatus } from "./AlexaForm";
import { IntegrationConfig } from "./IntegrationConfig";
import { PluginsPanel } from "./PluginsPanel";
import type { IntegrationEntry, PluginsApi } from "./pluginsApi";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const SKILL = "amzn1.ask.skill.46844077-2dc4-4bb2-8c76-60c103ab0076";
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const entry = (over: Partial<IntegrationEntry> = {}): IntegrationEntry => ({
  id: "alexa",
  name: "Alexa",
  description: "Talk to Friend from your Echo devices.",
  installed: true,
  enabled: true,
  state: "needs-setup",
  detail: 'Say "Alexa, ask jarvis assistant" once, then allow your Echo (press Configure).',
  steps: [{ text: "Create a free skill in the Alexa developer console.", done: true }, { text: "Switch the plugin on.", done: true }],
  ...over,
});
const view = (alexa: SettingsView["alexa"] = { installed: true, enabled: true, skillId: SKILL, invocationName: "jarvis assistant", allowed: [] }): SettingsView => ({
  provider: "claude-code",
  model: "claude-sonnet-5-5",
  apiKeySet: false,
  view: "companion",
  approvals: "manual",
  look: { ...DEFAULT_LOOK },
  ollama: { url: "http://127.0.0.1:11434", model: "qwen2.5:7b", vision: false, contextTokens: 8192 },
  claudeCode: { model: "sonnet", command: "claude", fallback: "ollama" },
  voice: { enabled: true, speakTyped: true, language: null, accept: 0.72, challenge: 0.58, ttsVoice: "en_US-lessac-medium", sttModel: "base" },
  alexa,
});
const settingsApi = (v = view()): SettingsApi => ({ get: vi.fn(async () => v), save: vi.fn(async () => ({ settings: v, changed: true, restart: [] })) });
const status = (over: Partial<AlexaStatus> = {}): AlexaStatus => ({
  installed: true,
  enabled: true,
  skillIdSet: true,
  invocationName: "jarvis assistant",
  endpoint: "https://friend.example.com/api/alexa",
  waiting: [],
  allowed: [],
  ...over,
});
const alexaApi = (s: AlexaStatus = status()): AlexaApi => ({ status: vi.fn(async () => s), allow: vi.fn(async () => {}), forget: vi.fn(async () => {}) });
const open = (a: AlexaApi, s: SettingsApi = settingsApi()) => render(<IntegrationConfig integration={entry()} onBack={() => {}} settingsApi={s} alexaApi={a} />);

describe("the Alexa Configure page", () => {
  it("shows the address to give Amazon, three files to download, the steps and what Alexa may do", async () => {
    open(alexaApi());
    expect(await screen.findByRole("heading", { name: "Alexa" })).toBeTruthy();
    expect(await screen.findByText("https://friend.example.com/api/alexa")).toBeTruthy();
    for (const f of ["skill.json", "en-IN.json", "hi-IN.json"]) {
      const link = screen.getByRole("link", { name: new RegExp(f.replace(".", "\\.")) }) as HTMLAnchorElement;
      expect(link.getAttribute("href")).toBe(`/api/alexa/package/${f}`);
      expect(link.hasAttribute("download")).toBe(true);
    }
    expect(screen.getByText("Create a free skill in the Alexa developer console.")).toBeTruthy();
    expect(screen.getAllByText(/free/i).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/refused/i).length).toBeGreaterThan(0);
    expect(screen.getByText(/address changes later/i)).toBeTruthy(); // the temporary-domain note
  });

  it("says a public address is needed, and offers no downloads, when there is none", async () => {
    open(alexaApi(status({ endpoint: null })));
    expect(await screen.findByText(/public address/i)).toBeTruthy();
    expect(screen.queryByRole("link", { name: /skill\.json/ })).toBeNull();
  });

  it("offers no downloads before an invocation name is saved", async () => {
    open(alexaApi(status({ invocationName: "" })));
    await screen.findByText("https://friend.example.com/api/alexa");
    expect(screen.queryByRole("link", { name: /skill\.json/ })).toBeNull();
    expect(screen.getByText(/save an invocation name/i)).toBeTruthy();
  });

  it("saves only what changed, after the PIN", async () => {
    const s = settingsApi(view({ installed: true, enabled: true, skillId: "", invocationName: "", allowed: [] }));
    open(alexaApi(), s);
    await userEvent.type(await screen.findByLabelText("Skill ID"), SKILL);
    await userEvent.type(screen.getByLabelText("Invocation name"), "jarvis assistant");
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => expect(s.save).toHaveBeenCalledWith({ alexa: { skillId: SKILL, invocationName: "jarvis assistant" } }, "123456"));
  });

  it("flags a name Amazon would refuse, and does not let it be saved", async () => {
    open(alexaApi());
    const name = await screen.findByLabelText("Invocation name");
    await userEvent.clear(name);
    await userEvent.type(name, "Maya");
    expect(screen.getByRole("alert").textContent).toMatch(/lower-case/i);
    expect((screen.getByRole("button", { name: /^Save/ }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.clear(name);
    await userEvent.type(name, "maya ask");
    expect(screen.getByRole("alert").textContent).toMatch(/ask/);
    await userEvent.clear(name);
    await userEvent.type(name, "maya");
    expect(screen.queryByRole("alert")).toBeNull(); // one word is fine in development mode
  });

  it("flags a skill id that is not one", async () => {
    open(alexaApi());
    const id = await screen.findByLabelText("Skill ID");
    await userEvent.clear(id);
    await userEvent.type(id, "hello");
    expect(screen.getByRole("alert").textContent).toMatch(/amzn1\.ask\.skill/);
    expect((screen.getByRole("button", { name: /^Save/ }) as HTMLButtonElement).disabled).toBe(true);
  });
});

describe("the Echo devices", () => {
  const waiting = { short: "AB12CD34", deviceShort: "0001", locale: "en-IN", at: Date.now() - 60_000 };

  it("lists a waiting Echo and allows it with the PIN", async () => {
    const api = alexaApi(status({ waiting: [waiting] }));
    open(api);
    const row = (await screen.findByText(/AB12CD34/)).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Allow" }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Allow this Echo" }));
    await waitFor(() => expect(api.allow).toHaveBeenCalledWith("AB12CD34", "123456"));
  });

  it("lists an allowed Echo and forgets it", async () => {
    const api = alexaApi(status({ allowed: [{ short: "EF56GH78", name: "Kitchen", addedAt: 1 }] }));
    open(api);
    const row = (await screen.findByText(/Kitchen/)).closest("li")!;
    expect(row.textContent).toMatch(/EF56GH78/);
    await userEvent.click(within(row).getByRole("button", { name: "Forget" }));
    await waitFor(() => expect(api.forget).toHaveBeenCalledWith("EF56GH78"));
  });

  it("says what to do when no Echo has asked yet", async () => {
    open(alexaApi());
    expect(await screen.findByText(/say .*Alexa, ask jarvis assistant/i)).toBeTruthy();
  });

  it("shows a wrong PIN as an error and keeps the Echo waiting", async () => {
    const api = alexaApi(status({ waiting: [waiting] }));
    vi.mocked(api.allow).mockRejectedValueOnce(new Error("Incorrect PIN"));
    open(api);
    const row = (await screen.findByText(/AB12CD34/)).closest("li")!;
    await userEvent.click(within(row).getByRole("button", { name: "Allow" }));
    await typePin("000000");
    await userEvent.click(screen.getByRole("button", { name: "Allow this Echo" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Incorrect PIN/);
  });
});

describe("the plugins list", () => {
  it("offers Alexa under Available with Install", async () => {
    const api: PluginsApi = {
      list: vi.fn(async () => ({ installed: [], catalog: [], integrations: [entry({ installed: false, enabled: false, state: "not-installed", detail: "" })] })),
      install: vi.fn(async () => {}),
      setEnabled: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
      reload: vi.fn(async () => {}),
    };
    render(<PluginsPanel api={api} onClose={() => {}} />);
    const row = (await screen.findByText("Alexa")).closest("li")!;
    expect(row.getAttribute("data-integration")).toBe("alexa");
    expect(row.closest(".plugins-body")).toBeTruthy(); // the list scrolls inside the window
    expect(within(row).getByRole("button", { name: "Install" })).toBeTruthy();
  });
});
