import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeForm, type ChromeAccessInfo, type ChromeApi, type ChromeInfo } from "./ChromeForm";
import { IntegrationConfig } from "./IntegrationConfig";
import type { IntegrationEntry } from "./pluginsApi";

afterEach(cleanup);

const FOLDER = "C:/Users/me/.chrome-control-mcp/extension";
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const info = (over: Partial<ChromeInfo> = {}): ChromeInfo => ({ state: "off", detail: "Switched off.", extensionFolder: FOLDER, ...over });
const access = (over: Partial<ChromeAccessInfo> = {}): ChromeAccessInfo => ({
  remote: false,
  mcpUrl: "https://friend.example.com/chrome/mcp",
  extensionAddress: "wss://friend.example.com/chrome/ws",
  extensionZip: "/api/plugins/chrome/extension.zip",
  ...over,
});
const api = (i: ChromeInfo = info(), a: ChromeAccessInfo = access()): ChromeApi => ({
  info: vi.fn(async () => i),
  setUp: vi.fn(async () => ({ ok: true, message: "Chrome control is installed." })),
  access: vi.fn(async () => a),
  setRemote: vi.fn(async () => {}),
  revealKey: vi.fn(async () => "the-secret-key-123"),
});

describe("the Chrome control Configure page", () => {
  it("shows the folder to load in Chrome, and can copy it", async () => {
    render(<ChromeForm api={api()} pollMs={0} />);
    expect(await screen.findByDisplayValue(FOLDER)).toBeTruthy();
    expect(screen.getAllByText(/chrome:\/\/extensions/).length).toBeGreaterThan(0);
    expect(screen.getByRole("button", { name: /copy/i })).toBeTruthy();
  });

  it("says what is going on right now, in the plugin's own words", async () => {
    render(<ChromeForm api={api(info({ state: "needs-setup", detail: "Load the extension in Chrome and switch it on (press Configure)." }))} pollMs={0} />);
    expect(await screen.findByText(/Load the extension in Chrome and switch it on/)).toBeTruthy();
  });

  it("has no folder to show before it is set up, and offers the setup instead", async () => {
    render(<ChromeForm api={api(info({ state: "needs-setup", detail: "Chrome control is not set up on this PC yet.", extensionFolder: null }))} pollMs={0} />);
    expect(await screen.findByText(/not set up on this PC yet/)).toBeTruthy();
    expect(screen.queryByDisplayValue(FOLDER)).toBeNull();
    expect(screen.getByRole("button", { name: /set up chrome control/i })).toBeTruthy();
  });

  it("sets up again with the PIN, and shows what came of it", async () => {
    const a = api(info({ extensionFolder: null, state: "needs-setup", detail: "Not set up." }));
    render(<ChromeForm api={a} pollMs={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /set up chrome control/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    await waitFor(() => expect(a.setUp).toHaveBeenCalledWith("123456"));
    expect(await screen.findByText(/Chrome control is installed/)).toBeTruthy();
  });

  it("shows a failed setup and does not hide the form", async () => {
    const a = api();
    (a.setUp as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Incorrect PIN"));
    render(<ChromeForm api={a} pollMs={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /set up again/i }));
    await typePin("000000");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Incorrect PIN/);
    expect(screen.getByRole("button", { name: /^continue$/i })).toBeTruthy();
  });

  it("looks again by itself while the page is open, so the owner sees the extension link up", async () => {
    const infos = [info({ state: "needs-setup", detail: "Load the extension in Chrome and switch it on (press Configure)." }), info({ state: "online", detail: "Connected to your Chrome." })];
    let n = 0;
    const a: ChromeApi = { ...api(), info: vi.fn(async () => infos[Math.min(n++, 1)]!) };
    render(<ChromeForm api={a} pollMs={20} />);
    expect(await screen.findByText(/Connected to your Chrome/)).toBeTruthy();
  });
});

describe("using Chrome control from another PC", () => {
  it("offers the extension to download as a zip, so it can be installed on another PC, and says how", async () => {
    render(<ChromeForm api={api()} pollMs={0} />);
    const link = (await screen.findByRole("link", { name: /download the extension/i })) as HTMLAnchorElement;
    expect(link.getAttribute("href")).toBe("/api/plugins/chrome/extension.zip");
    expect(link.hasAttribute("download")).toBe(true);
    expect(screen.getAllByText(/Load unpacked/i).length).toBeGreaterThan(0);
  });

  it("has no download when this Friend carries no extension", async () => {
    render(<ChromeForm api={api(info(), access({ extensionZip: null }))} pollMs={0} />);
    await screen.findByDisplayValue(FOLDER);
    expect(screen.queryByRole("link", { name: /download the extension/i })).toBeNull();
  });

  it("keeps the addresses back until the owner allows other PCs", async () => {
    render(<ChromeForm api={api()} pollMs={0} />);
    await screen.findByRole("button", { name: /allow other pcs/i });
    expect(screen.queryByDisplayValue("https://friend.example.com/chrome/mcp")).toBeNull();
    expect(screen.queryByDisplayValue("wss://friend.example.com/chrome/ws")).toBeNull();
  });

  it("allows other PCs with the PIN, then shows the two addresses on Friend's own address", async () => {
    const a = api();
    render(<ChromeForm api={a} pollMs={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /allow other pcs/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    await waitFor(() => expect(a.setRemote).toHaveBeenCalledWith(true, "123456"));
  });

  it("shows the addresses once allowed, and can stop allowing without a PIN", async () => {
    const a = api(info(), access({ remote: true }));
    render(<ChromeForm api={a} pollMs={0} />);
    expect(await screen.findByDisplayValue("https://friend.example.com/chrome/mcp")).toBeTruthy();
    expect(screen.getByDisplayValue("wss://friend.example.com/chrome/ws")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /stop allowing other pcs/i }));
    await waitFor(() => expect(a.setRemote).toHaveBeenCalledWith(false));
  });

  it("shows the key only after the PIN, and not before", async () => {
    const a = api(info(), access({ remote: true }));
    render(<ChromeForm api={a} pollMs={0} />);
    await screen.findByDisplayValue("https://friend.example.com/chrome/mcp");
    expect(screen.queryByText(/the-secret-key-123/)).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: /show the key/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    await waitFor(() => expect(a.revealKey).toHaveBeenCalledWith("123456"));
    expect(await screen.findByDisplayValue("the-secret-key-123")).toBeTruthy();
  });

  it("shows a wrong PIN as an error and keeps asking", async () => {
    const a = api(info(), access({ remote: true }));
    (a.revealKey as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Incorrect PIN"));
    render(<ChromeForm api={a} pollMs={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /show the key/i }));
    await typePin("000000");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Incorrect PIN/);
  });

  it("warns that the address is the one in use now, which another PC may not reach", async () => {
    render(<ChromeForm api={api(info(), access({ remote: true, mcpUrl: "http://127.0.0.1:8787/chrome/mcp", extensionAddress: "ws://127.0.0.1:8787/chrome/ws" }))} pollMs={0} />);
    expect(await screen.findByText(/another PC cannot reach 127\.0\.0\.1/i)).toBeTruthy();
  });
});

describe("inside Configure", () => {
  const entry: IntegrationEntry = {
    id: "chrome",
    name: "Chrome control",
    description: "x",
    installed: true,
    enabled: true,
    state: "needs-setup",
    detail: "Load the extension.",
    steps: [{ text: "Set Chrome control up.", done: true }],
  };
  it("says the state once, live, instead of twice (the list's line and the form's would be the same words)", async () => {
    render(<IntegrationConfig integration={{ ...entry, detail: "Switched off." }} onBack={() => {}} settingsApi={{ get: async () => ({}) as never, save: vi.fn() as never }} chromeApi={api(info({ detail: "Switched off." }))} />);
    await screen.findByDisplayValue(FOLDER);
    expect(screen.getAllByText("Switched off.")).toHaveLength(1);
  });
  it("is the page for the chrome plugin, with no Save button (nothing to type)", async () => {
    render(<IntegrationConfig integration={entry} onBack={() => {}} settingsApi={{ get: async () => ({}) as never, save: vi.fn() as never }} chromeApi={api()} />);
    expect(await screen.findByDisplayValue(FOLDER)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^save/i })).toBeNull();
    expect(screen.getByRole("button", { name: /back/i })).toBeTruthy();
  });
});
