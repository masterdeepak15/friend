import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OfficeTab, officeProblems } from "./OfficeTab";
import { SettingsPanel } from "./SettingsPanel";
import { DEFAULT_LOOK, type OfficeSettings, type SettingsApi, type SettingsView } from "./settingsApi";

afterEach(cleanup);

const role = { id: "scribe", title: "Scribe", instructions: "Write docs.", model: "", permission: "default" as const };
const project = { id: "site", name: "Site", folder: "C:\\work\\site", goal: "Ship v2", extraFolders: ["C:\\shared"] };
const base = (over: Partial<OfficeSettings> = {}): OfficeSettings => ({ enabled: false, maxConcurrent: 2, startTimeoutSec: 60, pauseAtWindow: 0.9, notifyFriend: true, autonomy: "low" as const, budget: { perWorkerTokens: 1000, totalTokens: 5000 }, roles: [role], projects: [project], policy: { allowTools: ["Read", "Grep"], denyCommands: ["git\\s+push"] }, ...over });

function mount(over: Partial<OfficeSettings> = {}) {
  const onChange = vi.fn();
  const office = base(over);
  render(<OfficeTab office={office} onChange={onChange} />);
  return { onChange, office };
}
const typeInto = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });

describe("the switches and numbers", () => {
  it("each sends exactly its own change", () => {
    const { onChange } = mount();
    fireEvent.click(screen.getByRole("checkbox", { name: /turn the office on/i }));
    expect(onChange).toHaveBeenLastCalledWith({ enabled: true });
    typeInto(/most workers at once/i, "3");
    expect(onChange).toHaveBeenLastCalledWith({ maxConcurrent: 3 });
    typeInto(/start timeout/i, "90");
    expect(onChange).toHaveBeenLastCalledWith({ startTimeoutSec: 90 });
    fireEvent.click(screen.getByRole("checkbox", { name: /tell friend when a worker finishes/i }));
    expect(onChange).toHaveBeenLastCalledWith({ notifyFriend: false });
    typeInto(/limit per worker/i, "2500");
    expect(onChange).toHaveBeenLastCalledWith({ budget: { perWorkerTokens: 2500, totalTokens: 5000 } });
    typeInto(/limit in total/i, "0");
    expect(onChange).toHaveBeenLastCalledWith({ budget: { perWorkerTokens: 1000, totalTokens: 0 } });
  });

  it("shows the pause point as a percent and saves it as a share, with 0 meaning never", () => {
    const { onChange } = mount();
    expect((screen.getByLabelText(/pause at/i) as HTMLInputElement).value).toBe("90");
    typeInto(/pause at/i, "75");
    expect(onChange).toHaveBeenLastCalledWith({ pauseAtWindow: 0.75 });
    typeInto(/pause at/i, "0");
    expect(onChange).toHaveBeenLastCalledWith({ pauseAtWindow: 0 });
  });

  it("explains each control in plain words, and where the program and model come from", () => {
    mount();
    expect(screen.getByText(/never pause/i)).toBeTruthy();
    expect(screen.getByText(/claude code program and model chosen under model/i)).toBeTruthy();
  });
});

describe("how much Friend decides", () => {
  it("shows the three levels with the saved one chosen, and sends exactly the level picked", () => {
    const { onChange } = mount({ autonomy: "medium" });
    const radio = (name: RegExp) => screen.getByRole("radio", { name }) as HTMLInputElement;
    expect(radio(/^medium/i).checked).toBe(true);
    expect(radio(/^low/i).checked).toBe(false);
    fireEvent.click(radio(/^high/i));
    expect(onChange).toHaveBeenLastCalledWith({ autonomy: "high" });
    fireEvent.click(radio(/^low/i));
    expect(onChange).toHaveBeenLastCalledWith({ autonomy: "low" });
  });
  it("says what stays refused at every level", () => {
    mount();
    expect(screen.getByText(/always refuses what is outside the project folders/i)).toBeTruthy();
  });
});

describe("roles", () => {
  it("are not edited here: Friend hires whoever the work needs, and the tab only says so", () => {
    mount();
    expect(screen.queryByRole("button", { name: /add a role/i })).toBeNull();
    expect(screen.queryByLabelText(/role 1 id/i)).toBeNull();
    expect(screen.getByText(/friend hires and manages the team/i)).toBeTruthy();
  });
});
describe("projects", () => {
  it("adds a blank project, edits its fields and its extra folders, and removes it", () => {
    const { onChange } = mount();
    fireEvent.click(screen.getByRole("button", { name: /add a project/i }));
    expect(onChange).toHaveBeenLastCalledWith({ projects: [project, { id: "", name: "", folder: "", goal: "", extraFolders: [] }] });
    typeInto(/project 1 folder/i, "D:\\code");
    expect(onChange).toHaveBeenLastCalledWith({ projects: [{ ...project, folder: "D:\\code" }] });
    typeInto(/project 1 extra folders/i, "D:\\a\n\nD:\\b ");
    expect(onChange).toHaveBeenLastCalledWith({ projects: [{ ...project, extraFolders: ["D:\\a", "D:\\b"] }] });
    fireEvent.click(screen.getByRole("button", { name: /remove project 1/i }));
    expect(onChange).toHaveBeenLastCalledWith({ projects: [] });
  });
});

describe("the rules", () => {
  it("sends one entry per line for the tools let through and the commands refused", () => {
    const { onChange } = mount();
    typeInto(/let through without asking/i, "Read\n\nGlob \n");
    expect(onChange).toHaveBeenLastCalledWith({ policy: { allowTools: ["Read", "Glob"], denyCommands: ["git\\s+push"] } });
    typeInto(/always refuse/i, "rm\\s+-rf\ncurl.*\\|\\s*sh");
    expect(onChange).toHaveBeenLastCalledWith({ policy: { allowTools: ["Read", "Grep"], denyCommands: ["rm\\s+-rf", "curl.*\\|\\s*sh"] } });
  });

  it("shows an invalid regular expression beside its line", () => {
    mount({ policy: { allowTools: [], denyCommands: ["git\\s+push", "(unclosed"] } });
    expect(screen.getByText(/line 2.*\(unclosed.*not a valid pattern/i)).toBeTruthy();
  });
});

describe("problems that block saving", () => {
  it("flag a bad or repeated id, an empty folder and a bad pattern", () => {
    expect(officeProblems(base())).toEqual([]);
    expect(officeProblems(base({ projects: [{ ...project, folder: "  " }] })).join(" ")).toMatch(/project 1.*folder/i);
    expect(officeProblems(base({ projects: [project, { ...project, name: "Again" }] })).join(" ")).toMatch(/same id/i);
    expect(officeProblems(base({ projects: [{ ...project, extraFolders: ["a", "b", "c", "d", "e", "f"] }] })).join(" ")).toMatch(/at most 5/i);
    expect(officeProblems(base({ policy: { allowTools: [], denyCommands: ["(unclosed"] } })).join(" ")).toMatch(/\(unclosed/);
  });

  it("show on the tab, and an empty folder is flagged beside the project", () => {
    mount({ projects: [{ ...project, folder: "" }] });
    expect(screen.getByText(/project 1 needs a folder/i)).toBeTruthy();
  });
});

describe("inside the settings panel", () => {
  const view = (office?: OfficeSettings): SettingsView => ({
    provider: "claude-code",
    model: "claude-sonnet-5-5",
    apiKeySet: false,
    view: "companion",
    look: { ...DEFAULT_LOOK },
    ollama: { url: "http://127.0.0.1:11434", model: "qwen2.5:7b", vision: false, contextTokens: 8192 },
    claudeCode: { model: "sonnet", command: "claude", fallback: "ollama" },
    voice: { enabled: true, speakTyped: true, language: null, accept: 0.72, challenge: 0.58, ttsVoice: "en_US-lessac-medium", sttModel: "base" },
    ...(office ? { office } : {}),
  });
  const apiOf = (v: SettingsView): SettingsApi => ({ get: async () => v, save: vi.fn(async () => ({ settings: v, changed: true, restart: [] })) });

  it("has an Office tab that shows the form and saves through the PIN", async () => {
    const api = apiOf(view(base()));
    render(<SettingsPanel api={api} onClose={() => {}} initialTab="office" />);
    const box = await screen.findByRole("checkbox", { name: /turn the office on/i });
    fireEvent.click(box);
    fireEvent.click(screen.getByRole("button", { name: /^save/i }));
    expect(await screen.findByText(/enter your pin/i)).toBeTruthy();
  });

  it("cannot be saved while something is wrong", async () => {
    const api = apiOf(view(base({ projects: [{ ...project, folder: "" }] })));
    render(<SettingsPanel api={api} onClose={() => {}} initialTab="office" />);
    fireEvent.click(await screen.findByRole("checkbox", { name: /turn the office on/i }));
    expect((screen.getByRole("button", { name: /^save/i }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows no tab body when the settings have no office", async () => {
    render(<SettingsPanel api={apiOf(view())} onClose={() => {}} initialTab="office" />);
    await screen.findByRole("tab", { name: /office/i });
    expect(screen.queryByRole("checkbox", { name: /turn the office on/i })).toBeNull();
  });
});
