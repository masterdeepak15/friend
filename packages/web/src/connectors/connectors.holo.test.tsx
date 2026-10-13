import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConnectorsPanel } from "./ConnectorsPanel";
import type { ConnectorList, ConnectorView, ConnectorsApi } from "./connectorsApi";

afterEach(cleanup);

const chromePreset = {
  id: "chrome",
  name: "Chrome control",
  description: "Lets Friend use your Chrome.",
  quick: true,
  connector: { id: "chrome", name: "Chrome control", kind: "stdio" as const, command: "npx", args: ["-y", "chrome-control-mcp"] },
  setup: ["Install it once."],
};
const gmailPreset = {
  id: "gmail",
  name: "Gmail",
  description: "Search, read and write your email.",
  connector: { id: "gmail", name: "Gmail", kind: "stdio" as const, command: "npx", args: ["-y", "gmail-mcp"] },
  setup: ["Create the Google credentials."],
};
const view = (n: number, over: Partial<ConnectorView> = {}): ConnectorView => ({ id: `c${n}`, name: `Conn ${n}`, kind: "stdio", enabled: n % 2 === 1, status: n % 2 === 1 ? "ready" : "off", error: null, tools: 3, target: `npx server-${n}`, secret: false, ...over });
const READY = { preset: "chrome", name: "Chrome control", ready: true, message: "Chrome control is installed on this PC.", installCommand: null, manualStep: null, extensionFolder: null };

function setup(connectors: ConnectorView[], overrides: Partial<ConnectorsApi> = {}) {
  const state: ConnectorList = { connectors, presets: [chromePreset, gmailPreset] };
  const api: ConnectorsApi = {
    list: vi.fn(async () => state),
    add: vi.fn(async (c) => view(1, { id: c.id, name: c.name })),
    setEnabled: vi.fn(async (id, enabled) => view(1, { id, enabled, status: enabled ? "ready" : "off" })),
    reload: vi.fn(async (id) => view(1, { id })),
    remove: vi.fn(async () => {}),
    quickCheck: vi.fn(async () => READY),
    quickInstall: vi.fn(async () => ({ ok: true, output: "", extensionFolder: null, message: "installed" })),
    quickConnect: vi.fn(async () => ({ ok: true, extension: "connected" as const, connector: { id: "chrome", name: "Chrome control", status: "ready", error: null, tools: 32 }, message: "Chrome control is on." })),
    ...overrides,
  };
  const onClose = vi.fn();
  render(<ConnectorsPanel api={api} onClose={onClose} variant="holo" />);
  return { api, onClose };
}
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const cards = () => screen.getAllByRole("listitem");
const card = async (name: string) => within((await screen.findByText(name, { selector: "strong" })).closest("li") as HTMLElement);

describe("connectors in the glass panel", () => {
  it("has a Connected tab and an Add tab, each with its count", async () => {
    setup([view(1), view(2)]);
    expect(await screen.findByRole("tab", { name: /Connected\s*2/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Add\s*3/ })).toBeTruthy(); // two presets and "Something else"
    expect(screen.getByRole("dialog", { name: "Connectors" })).toBeTruthy();
  });

  it("shows how each one is doing, with its tools or what went wrong", async () => {
    setup([view(1), view(2, { status: "error", enabled: true, error: "It crashed" }), view(3, { status: "connecting" })]);
    expect((await card("Conn 1")).getByText("Ready")).toBeTruthy();
    expect((await card("Conn 1")).getByText(/3 tools/)).toBeTruthy();
    expect((await card("Conn 2")).getByText("Not working")).toBeTruthy();
    expect((await card("Conn 2")).getByText("It crashed").className).toMatch(/auth-error/);
    expect((await card("Conn 3")).getByText("Connecting…")).toBeTruthy();
  });

  it("pages through the connected ones six at a time", async () => {
    setup(Array.from({ length: 8 }, (_, i) => view(i + 1)));
    await screen.findByRole("tab", { name: /Connected\s*8/ });
    expect(cards()).toHaveLength(6);
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(cards()).toHaveLength(2);
    expect(screen.getByText("Conn 8")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
  });

  it("has no arrows when everything fits on one page", async () => {
    setup([view(1)]);
    await screen.findByRole("tab", { name: /Connected\s*1/ });
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });

  it("turns one off, reloads it and removes it from its card", async () => {
    const { api } = setup([view(1)]);
    const c = await card("Conn 1");
    await userEvent.click(c.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith("c1", false));
    await userEvent.click((await card("Conn 1")).getByRole("button", { name: "Reload" }));
    await waitFor(() => expect(api.reload).toHaveBeenCalledWith("c1"));
    await userEvent.click((await card("Conn 1")).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("c1"));
  });

  it("turning one on asks for the PIN in the panel, then sends it", async () => {
    const { api } = setup([view(2)]);
    await userEvent.click((await card("Conn 2")).getByRole("button", { name: "Turn on" }));
    expect(screen.getByText(/enter your pin to confirm/i)).toBeTruthy();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith("c2", true, "123456"));
    expect(await screen.findByRole("tab", { name: /Connected/ })).toBeTruthy(); // back on the list
  });

  it("lists what can be added on the Add tab, and a connector that is already connected cannot be added twice", async () => {
    setup([view(1, { id: "gmail", name: "Gmail" })]);
    await userEvent.click(await screen.findByRole("tab", { name: /Add/ }));
    expect(await card("Chrome control")).toBeTruthy();
    expect((await card("Gmail")).getByRole("button", { name: "Add" }).hasAttribute("disabled")).toBe(true);
    expect((await card("Something else")).getByRole("button", { name: "Add" })).toBeTruthy();
  });

  it("connects a one-click connector through the same steps, ending at the PIN", async () => {
    const { api } = setup([]);
    await userEvent.click(await screen.findByRole("tab", { name: /Add/ }));
    await userEvent.click((await card("Chrome control")).getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.quickCheck).toHaveBeenCalledWith("chrome"));
    expect(await screen.findByText(/enter your pin to continue/i)).toBeTruthy();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.quickConnect).toHaveBeenCalledWith("chrome", "123456"));
    expect(await screen.findByText("Chrome control is on.")).toBeTruthy();
  });

  it("opens the form for something else and goes back to the list", async () => {
    setup([]);
    await userEvent.click(await screen.findByRole("tab", { name: /Add/ }));
    await userEvent.click((await card("Something else")).getByRole("button", { name: "Add" }));
    expect(screen.getByLabelText("Name")).toBeTruthy();
    expect(screen.queryByRole("tab", { name: /Connected/ })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByRole("tab", { name: /Connected/ })).toBeTruthy();
  });

  it("says so when nothing is connected, and Done closes", async () => {
    const { onClose } = setup([]);
    expect(await screen.findByText(/nothing connected yet/i)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is still the classic panel unless asked for the glass one", async () => {
    const api: ConnectorsApi = { list: vi.fn(async () => ({ connectors: [], presets: [] })), add: vi.fn(), setEnabled: vi.fn(), reload: vi.fn(), remove: vi.fn(), quickCheck: vi.fn(), quickInstall: vi.fn(), quickConnect: vi.fn() } as unknown as ConnectorsApi;
    render(<ConnectorsPanel api={api} onClose={() => {}} />);
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(screen.queryByRole("tab")).toBeNull();
  });
});
