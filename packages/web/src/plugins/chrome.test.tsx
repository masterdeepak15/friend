import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeForm, type ChromeApi, type ChromeInfo } from "./ChromeForm";
import { IntegrationConfig } from "./IntegrationConfig";
import type { IntegrationEntry } from "./pluginsApi";

afterEach(cleanup);

const FOLDER = "C:/Users/me/.chrome-control-mcp/extension";
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const info = (over: Partial<ChromeInfo> = {}): ChromeInfo => ({ state: "off", detail: "Switched off.", extensionFolder: FOLDER, ...over });
const api = (i: ChromeInfo = info()): ChromeApi => ({
  info: vi.fn(async () => i),
  setUp: vi.fn(async () => ({ ok: true, message: "Chrome control is installed." })),
});

describe("the Chrome control Configure page", () => {
  it("shows the folder to load in Chrome, and can copy it", async () => {
    render(<ChromeForm api={api()} pollMs={0} />);
    expect(await screen.findByDisplayValue(FOLDER)).toBeTruthy();
    expect(screen.getByText(/chrome:\/\/extensions/)).toBeTruthy();
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
    const a: ChromeApi = { info: vi.fn(async () => infos[Math.min(n++, 1)]!), setUp: vi.fn() as never };
    render(<ChromeForm api={a} pollMs={20} />);
    expect(await screen.findByText(/Connected to your Chrome/)).toBeTruthy();
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
  it("is the page for the chrome plugin, with no Save button (nothing to type)", async () => {
    render(<IntegrationConfig integration={entry} onBack={() => {}} settingsApi={{ get: async () => ({}) as never, save: vi.fn() as never }} chromeApi={api()} />);
    expect(await screen.findByDisplayValue(FOLDER)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^save/i })).toBeNull();
    expect(screen.getByRole("button", { name: /back/i })).toBeTruthy();
  });
});
