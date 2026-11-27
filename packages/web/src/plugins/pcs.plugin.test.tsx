import { NO_PC_PERMISSIONS } from "@friend/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationConfig } from "./IntegrationConfig";
import type { IntegrationEntry, PluginList, PluginsApi } from "./pluginsApi";
import { PluginsPanel } from "./PluginsPanel";
import type { PcsApi } from "./pcsApi";

afterEach(cleanup);

const entry = (over: Partial<IntegrationEntry> = {}): IntegrationEntry => ({
  id: "windows-pcs",
  name: "Windows PCs",
  description: "Lets Friend use your Windows PCs like a person.",
  installed: false,
  enabled: false,
  state: "not-installed",
  detail: "",
  steps: [{ text: "Switch the plugin on.", done: false }, { text: "Press Configure, then Add a PC.", done: false }],
  ...over,
});

function listApi(integrations: IntegrationEntry[]): PluginsApi {
  const list: PluginList = { installed: [], catalog: [], integrations };
  return { list: vi.fn(async () => list), install: vi.fn(async () => {}), setEnabled: vi.fn(async () => {}), remove: vi.fn(async () => {}), reload: vi.fn(async () => {}) };
}

const pcsApi = (): PcsApi => ({
  list: vi.fn(async () => [{ id: 1, name: "Office PC", os: "Windows 11", host: "OFFICE", online: true, permissions: { ...NO_PC_PERMISSIONS, control: true }, status: { state: "idle" as const, at: 1 }, lastSeen: Date.now(), revoked: false, lease: null }]),
  add: vi.fn(),
  reissue: vi.fn(),
  setPermissions: vi.fn(),
  revoke: vi.fn(),
  remove: vi.fn(),
  control: vi.fn(),
});

describe("Windows PCs on the plugins screen", () => {
  it("is offered under Available like Chrome control and the other integrations, to be installed with the PIN", async () => {
    const api = listApi([entry()]);
    render(<PluginsPanel api={api} onClose={() => {}} />);
    const card = (await screen.findByText("Windows PCs")).closest("li")!;
    expect(within(card).getByText(/Lets Friend use your Windows PCs/)).toBeTruthy();
    await userEvent.click(within(card).getByRole("button", { name: "Install" }));
    expect(screen.getByText(/Enter your PIN to confirm/)).toBeTruthy();
    for (const d of "123456") await userEvent.click(screen.getByRole("button", { name: d }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.install).toHaveBeenCalledWith("windows-pcs", "123456"));
  });

  it("once installed it has Configure, Turn on and Remove, and is not a loose button on the page", async () => {
    render(<PluginsPanel api={listApi([entry({ installed: true, enabled: true, state: "needs-setup", detail: "No PC yet. Press Configure, then Add a PC." })])} onClose={() => {}} />);
    const card = (await screen.findByText("Windows PCs")).closest("li")!;
    expect(within(card).getByRole("button", { name: "Configure" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Turn off" })).toBeTruthy();
    expect(within(card).getByRole("button", { name: "Remove" })).toBeTruthy();
    expect(screen.getAllByText("Windows PCs")).toHaveLength(1);
  });
});

describe("the Configure page of Windows PCs", () => {
  it("shows what to do, then the PCs with their status, and no Save button (PCs save by themselves)", async () => {
    const onBack = vi.fn();
    render(<IntegrationConfig integration={entry({ installed: true, enabled: true, state: "online", detail: "1 of 1 PC online." })} onBack={onBack} pcsApi={pcsApi()} />);
    expect(await screen.findByText("Office PC")).toBeTruthy();
    expect(screen.getByText(/Switch the plugin on/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a PC" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalledTimes(1);
  });

  it("opens from the Configure button of the card and comes back to the list", async () => {
    render(<PluginsPanel api={listApi([entry({ installed: true, enabled: true, state: "online", detail: "1 of 1 PC online." })])} onClose={() => {}} />);
    const card = (await screen.findByText("Windows PCs")).closest("li")!;
    await userEvent.click(within(card).getByRole("button", { name: "Configure" }));
    expect(await screen.findByRole("button", { name: "Add a PC" })).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("button", { name: "Reload plugins" })).toBeTruthy();
  });
});
