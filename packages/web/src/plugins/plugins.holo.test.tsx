import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { IntegrationEntry, PluginList, PluginsApi } from "./pluginsApi";
import { PluginsPanel } from "./PluginsPanel";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const installedPlugin = (n: number) => ({ id: `plug-${n}`, name: `Plugin ${n}`, version: "1.0.0", description: "d", enabled: n % 2 === 1, error: null, skills: [{ name: "s", description: "d" }], tools: [] });
const offer = (n: number) => ({ id: `offer-${n}`, name: `Offer ${n}`, version: "2.0.0", description: `Does thing ${n}`, tools: 1, skills: 0, error: null, installed: false });
const integration = (id: string, name: string, over: Partial<IntegrationEntry> = {}): IntegrationEntry => ({ id, name, description: `${name} lets Friend reach it`, installed: true, enabled: true, state: "online", detail: "Ready.", steps: [], ...over }) as IntegrationEntry;

function setup(list: Partial<PluginList> = {}, overrides: Partial<PluginsApi> = {}) {
  const state: PluginList = {
    installed: Array.from({ length: 8 }, (_, i) => installedPlugin(i + 1)),
    catalog: Array.from({ length: 9 }, (_, i) => offer(i + 1)),
    integrations: [integration("telegram", "Telegram"), integration("twilio", "WhatsApp and SMS", { installed: false, enabled: false, state: "not-installed" })],
    ...list,
  } as PluginList;
  const api: PluginsApi = {
    list: vi.fn(async () => state),
    install: vi.fn(async () => {}),
    setEnabled: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    ...overrides,
  };
  const onClose = vi.fn();
  render(<PluginsPanel api={api} onClose={onClose} variant="holo" />);
  return { api, onClose };
}
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const cards = () => screen.getAllByRole("listitem");
const loaded = () => screen.findAllByRole("listitem");

describe("plugins in the glass panel", () => {
  it("shows the installed ones first, six cards a page, with the number on each tab", async () => {
    setup();
    expect(await screen.findByRole("tab", { name: /Installed\s*9/ })).toBeTruthy(); // 8 plugins and Telegram
    expect(screen.getByRole("tab", { name: /Available\s*10/ })).toBeTruthy(); // 9 in the catalog and Twilio
    expect(cards()).toHaveLength(6);
    expect(within(cards()[0]!).getByText("Telegram")).toBeTruthy(); // integrations first, like the classic list
  });

  it("pages through the cards with the arrows and shows which page it is on", async () => {
    setup();
    await screen.findByRole("tab", { name: /Installed/ });
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
    expect(cards()).toHaveLength(3); // 9 installed: 6 then 3
    expect(screen.getByText("Plugin 8")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Next page" })); // round to the start
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
  });

  it("has no arrows when everything fits on one page", async () => {
    setup({ installed: [installedPlugin(1)], catalog: [], integrations: [] });
    await screen.findByRole("tab", { name: /Installed\s*1/ });
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });

  it("switches between Installed and Available, starting again from the first page", async () => {
    setup();
    await userEvent.click(await screen.findByRole("button", { name: "Next page" }));
    await userEvent.click(screen.getByRole("tab", { name: /Available/ }));
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
    expect(within(cards()[0]!).getByText("WhatsApp and SMS")).toBeTruthy();
    expect(within(cards()[0]!).getByRole("button", { name: "Install" })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Available/ }).getAttribute("aria-selected")).toBe("true");
  });

  it("each card keeps the buttons the classic list has", async () => {
    setup();
    await loaded();
    const telegram = within(cards()[0]!);
    expect(telegram.getByRole("button", { name: "Configure" })).toBeTruthy();
    expect(telegram.getByRole("button", { name: "Turn off" })).toBeTruthy();
    expect(telegram.getByRole("button", { name: "Remove" })).toBeTruthy();
    const plain = within(cards()[1]!); // Plugin 1: a plain plugin, no Configure
    expect(plain.queryByRole("button", { name: "Configure" })).toBeNull();
  });

  it("shows how each one is doing", async () => {
    setup({ integrations: [integration("telegram", "Telegram", { state: "error", detail: "Token rejected" })] });
    const card = within((await screen.findByText("Telegram")).closest("li") as HTMLElement);
    expect(card.getByText("Not working")).toBeTruthy();
    expect(card.getByText("Token rejected").className).toMatch(/auth-error/);
  });

  it("turning something off and removing it work from the card, and the list refreshes", async () => {
    const { api } = setup();
    const card = within((await screen.findByText("Plugin 2")).closest("li") as HTMLElement);
    expect(card.getByText("(off)", { exact: false })).toBeTruthy(); // even numbers are off
    await userEvent.click(card.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("plug-2"));
    await waitFor(() => expect((api.list as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2));
  });

  it("installing asks for the PIN in the panel, then sends it", async () => {
    const { api } = setup();
    await userEvent.click(await screen.findByRole("tab", { name: /Available/ }));
    await userEvent.click(within((await screen.findByText("Offer 1")).closest("li") as HTMLElement).getByRole("button", { name: "Install" }));
    expect(screen.getByText(/enter your pin to confirm/i)).toBeTruthy();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.install).toHaveBeenCalledWith("offer-1", "123456"));
  });

  it("opens an integration's setup page inside the panel and comes back", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, status: 200, json: async () => ({}) })));
    setup();
    await loaded();
    await userEvent.click(within(cards()[0]!).getByRole("button", { name: "Configure" }));
    expect(screen.queryByRole("tab", { name: /Installed/ })).toBeNull(); // the setup page replaces the list
    expect(screen.getByRole("dialog", { name: "Plugins" })).toBeTruthy();
  });

  it("reloads the plugins from the footer, and Done closes", async () => {
    const { api, onClose } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Reload plugins" }));
    expect(api.reload).toHaveBeenCalledTimes(1);
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("goes back a page when the last card of the last page is removed", async () => {
    let installed = Array.from({ length: 7 }, (_, i) => installedPlugin(i + 1));
    const api: PluginsApi = {
      list: vi.fn(async () => ({ installed, catalog: [], integrations: [] }) as unknown as PluginList),
      install: vi.fn(async () => {}),
      setEnabled: vi.fn(async () => {}),
      remove: vi.fn(async (id: string) => void (installed = installed.filter((p) => p.id !== id))),
      reload: vi.fn(async () => {}),
    };
    render(<PluginsPanel api={api} onClose={() => {}} variant="holo" />);
    await userEvent.click(await screen.findByRole("button", { name: "Next page" }));
    expect(cards()).toHaveLength(1);
    await userEvent.click(within(cards()[0]!).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(cards()).toHaveLength(6));
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull(); // one page now
  });

  it("says so when there is nothing to show", async () => {
    setup({ installed: [], catalog: [], integrations: [] });
    expect(await screen.findByText(/nothing installed yet/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: /Available/ }));
    expect(screen.getByText(/everything in the catalog is installed/i)).toBeTruthy();
  });
});
