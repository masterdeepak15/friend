import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerMenu } from "../overlay/OwnerMenu";
import type { PluginList, PluginsApi } from "./pluginsApi";
import { PluginsPanel } from "./PluginsPanel";

afterEach(cleanup);

const standup = { id: "standup-writer", name: "Stand-up writer", version: "1.0.0", description: "Writes stand-ups", tools: 0, skills: 1, error: null };
const converter = { id: "unit-converter", name: "Unit converter", version: "1.0.0", description: "Converts units", tools: 1, skills: 0, error: null };
const installedDuck = {
  id: "rubber-duck",
  name: "Rubber duck",
  version: "1.0.0",
  description: "Debug by asking",
  enabled: true,
  error: null,
  skills: [{ name: "duck", description: "d" }],
  tools: [],
};

function setup(list: Partial<PluginList> = {}, overrides: Partial<PluginsApi> = {}) {
  let state: PluginList = {
    installed: [installedDuck],
    catalog: [{ ...standup, installed: false }, { ...converter, installed: false }, { ...installedDuck, tools: 0, skills: 1, installed: true }],
    ...list,
  };
  const api: PluginsApi = {
    list: vi.fn(async () => state),
    install: vi.fn(async () => {}),
    setEnabled: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    ...overrides,
  };
  const onClose = vi.fn();
  render(<PluginsPanel api={api} onClose={onClose} />);
  return { api, onClose, set: (s: PluginList) => (state = s) };
}
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const row = async (name: RegExp) => within((await screen.findByText(name)).closest("li") as HTMLElement);

describe("<PluginsPanel>", () => {
  it("shows what is installed and what the catalog offers, without offering what is already installed", async () => {
    setup();
    const installed = await row(/Rubber duck/);
    expect(installed.getByRole("button", { name: /turn off/i })).toBeTruthy();
    expect(installed.getByRole("button", { name: /remove/i })).toBeTruthy();
    const offer = await row(/Unit converter/);
    expect(offer.getByText(/1 tool/)).toBeTruthy();
    expect(offer.getByRole("button", { name: /install/i })).toBeTruthy();
    expect(screen.getAllByText(/Rubber duck/)).toHaveLength(1); // not listed again under the catalog
  });

  it("installing asks for the PIN, warns that tools run in a sandbox, and sends the PIN with the id", async () => {
    const { api } = setup();
    await userEvent.click((await row(/Unit converter/)).getByRole("button", { name: /install/i }));
    expect(screen.getByText(/sandbox/i)).toBeTruthy();
    const confirm = screen.getByRole("button", { name: /^confirm$/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await typePin("12345");
    expect(confirm.disabled).toBe(true);
    await typePin("6");
    await userEvent.click(confirm);
    expect(api.install).toHaveBeenCalledWith("unit-converter", "123456");
    await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2)); // refreshed afterwards
  });

  it("a skill-only plugin does not carry the sandbox warning", async () => {
    setup();
    await userEvent.click((await row(/Stand-up writer/)).getByRole("button", { name: /install/i }));
    expect(screen.queryByText(/sandbox/i)).toBeNull();
  });

  it("turning off needs no PIN", async () => {
    const { api } = setup();
    await userEvent.click((await row(/Rubber duck/)).getByRole("button", { name: /turn off/i }));
    expect(api.setEnabled).toHaveBeenCalledWith("rubber-duck", false, undefined);
  });

  it("turning on needs the PIN, and says it is off meanwhile", async () => {
    const { api } = setup({ installed: [{ ...installedDuck, enabled: false }], catalog: [] });
    const r = await row(/Rubber duck/);
    expect(r.getByText(/\(off\)/)).toBeTruthy();
    await userEvent.click(r.getByRole("button", { name: /turn on/i }));
    expect(api.setEnabled).not.toHaveBeenCalled();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect(api.setEnabled).toHaveBeenCalledWith("rubber-duck", true, "123456");
  });

  it("removes a plugin", async () => {
    const { api } = setup();
    await userEvent.click((await row(/Rubber duck/)).getByRole("button", { name: /remove/i }));
    expect(api.remove).toHaveBeenCalledWith("rubber-duck");
  });

  it("shows the server's reason when something fails and clears the PIN", async () => {
    const install = vi.fn().mockRejectedValueOnce(new Error("Incorrect PIN."));
    setup({}, { install });
    await userEvent.click((await row(/Stand-up writer/)).getByRole("button", { name: /install/i }));
    await typePin("000000");
    await userEvent.click(screen.getByRole("button", { name: /^confirm$/i }));
    expect((await screen.findByRole("alert")).textContent).toContain("Incorrect PIN.");
    expect(screen.getByTestId("pin-dots").textContent).toBe("");
  });

  it("says why a broken plugin cannot be used", async () => {
    setup({ installed: [{ ...installedDuck, error: "The file \"skills/duck.md\" does not exist." }] });
    expect((await screen.findByText(/cannot be used/i)).textContent).toContain("duck.md");
  });

  it("lets the owner back out of the PIN step and close the panel", async () => {
    const { api, onClose } = setup();
    await userEvent.click((await row(/Stand-up writer/)).getByRole("button", { name: /install/i }));
    await userEvent.click(screen.getByRole("button", { name: /^back$/i }));
    expect(screen.queryByTestId("pin-dots")).toBeNull();
    expect(api.install).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(onClose).toHaveBeenCalled();
  });

  it("ignores a late reply after it was closed", async () => {
    let release: (l: PluginList) => void = () => {};
    const list = vi.fn(() => new Promise<PluginList>((r) => (release = r)));
    const { unmount } = render(<PluginsPanel api={{ list } as unknown as PluginsApi} onClose={() => {}} />);
    unmount();
    release({ installed: [], catalog: [] });
    await Promise.resolve(); // nothing to assert except that nothing throws
  });
});

describe("<OwnerMenu> plugins entry", () => {
  it("opens the panel", async () => {
    const onPlugins = vi.fn();
    render(<OwnerMenu muted={false} onToggleMute={() => {}} onSignedOut={() => {}} onPlugins={onPlugins} />);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: /plugins/i }));
    expect(onPlugins).toHaveBeenCalled();
  });
});
