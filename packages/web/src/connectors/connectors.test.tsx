import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerMenu } from "../overlay/OwnerMenu";
import { ConnectorsPanel } from "./ConnectorsPanel";
import { parseEnv, parseHeaders, parseLines, type ConnectorList, type ConnectorView, type ConnectorsApi } from "./connectorsApi";

afterEach(cleanup);

const chromePreset = {
  id: "chrome",
  name: "Chrome control",
  description: "Lets Friend use your Chrome.",
  quick: true,
  connector: { id: "chrome", name: "Chrome control", kind: "stdio" as const, command: "npx", args: ["-y", "chrome-control-mcp"] },
  setup: ["Install it once: npm install -g chrome-control-mcp", "Load the extension."],
  warning: "While the extension is on, Friend can act as you on any site it allows.",
};
const gmailPreset = {
  id: "gmail",
  name: "Gmail",
  description: "Search, read and write your email.",
  connector: { id: "gmail", name: "Gmail", kind: "stdio" as const, command: "npx", args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"] },
  setup: ["Create the Google credentials.", "Sign in on Google's own page."],
  warning: "Only approve a send you recognise.",
};
const view = (over: Partial<ConnectorView> = {}): ConnectorView => ({ id: "gmail", name: "Gmail", kind: "stdio", enabled: true, status: "ready", error: null, tools: 14, target: "npx -y @gongrzhe/server-gmail-autoauth-mcp", secret: false, ...over });

const READY = { preset: "chrome", name: "Chrome control", ready: true, message: "Chrome control is installed on this PC.", installCommand: null, manualStep: null, extensionFolder: "C:/Users/me/.chrome-control-mcp/extension" };
const NOT_READY = {
  preset: "chrome",
  name: "Chrome control",
  ready: false,
  message: "Chrome control is not installed on this PC yet. Please install it first, then press Connect again.",
  installCommand: "npx -y chrome-control-mcp setup",
  manualStep: "One step only you can do: open chrome://extensions, turn on Developer mode, click Load unpacked.",
  extensionFolder: null,
};
const CONNECTED = { ok: true, extension: "connected" as const, connector: { id: "chrome", name: "Chrome control", status: "ready", error: null, tools: 32 }, message: "Chrome control is on with 32 tools. Your Chrome extension is connected." };

function setup(connectors: ConnectorView[] = [], overrides: Partial<ConnectorsApi> = {}) {
  let state: ConnectorList = { connectors, presets: [chromePreset, gmailPreset] };
  const api: ConnectorsApi = {
    list: vi.fn(async () => state),
    add: vi.fn(async (c) => view({ id: c.id, name: c.name })),
    setEnabled: vi.fn(async (id, enabled) => view({ id, enabled, status: enabled ? "ready" : "off" })),
    reload: vi.fn(async (id) => view({ id })),
    remove: vi.fn(async () => {}),
    quickCheck: vi.fn(async () => READY),
    quickInstall: vi.fn(async () => ({ ok: true, output: "", extensionFolder: "C:/Users/me/.chrome-control-mcp/extension", message: "Chrome control is installed. One step only you can do: load the extension." })),
    quickConnect: vi.fn(async () => CONNECTED),
    ...overrides,
  };
  const onClose = vi.fn();
  render(<ConnectorsPanel api={api} onClose={onClose} />);
  return { api, onClose, set: (c: ConnectorView[]) => (state = { ...state, connectors: c }) };
}
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
/** The lists on the page: the connected ones first, the ones to add last. */
const connectedRow = async (name: string) => {
  await screen.findByText("Connected");
  const first = screen.getAllByRole("list")[0]!;
  return within(within(first).getByText(name, { selector: "strong" }).closest("li") as HTMLElement);
};
const addButton = async (name: RegExp) => {
  await screen.findByText("Connected");
  const lists = screen.getAllByRole("list");
  const li = within(lists[lists.length - 1]!).getByText(name, { selector: "strong" }).closest("li") as HTMLElement;
  return within(li).getByRole("button", { name: /^(Add|Connect)$/ });
};

describe("<ConnectorsPanel> list", () => {
  it("shows what is connected, whether it works, and says when nothing is", async () => {
    setup([view(), view({ id: "chrome", name: "Chrome control", status: "error", error: "chrome-control-mcp: command not found", tools: 0, target: "chrome-control-mcp" }), view({ id: "old", name: "Old", enabled: false, status: "off", tools: 0 })]);
    expect(await screen.findByText(/Ready · 14 tools/)).toBeTruthy();
    expect(screen.getByText(/Not working/)).toBeTruthy();
    expect(screen.getByText(/command not found/)).toBeTruthy();
    expect(screen.getByText("Off")).toBeTruthy();
    cleanup();
    setup([]);
    expect(await screen.findByText(/Nothing connected yet/)).toBeTruthy();
  });

  it("marks that a secret is saved without showing it", async () => {
    setup([view({ secret: true })]);
    expect(await screen.findByText(/secret saved/)).toBeTruthy();
  });

  it("turns one off without the PIN, and asks for the PIN to turn one on", async () => {
    const { api } = setup([view(), view({ id: "old", name: "Old", enabled: false, status: "off", tools: 0 })]);
    const gmail = await connectedRow("Gmail");
    await userEvent.click(gmail.getByRole("button", { name: "Turn off" }));
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith("gmail", false));
    const old = await connectedRow("Old");
    await userEvent.click(old.getByRole("button", { name: "Turn on" }));
    expect(screen.getByText(/Enter your PIN/)).toBeTruthy();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.setEnabled).toHaveBeenCalledWith("old", true, "123456"));
    expect(await screen.findByText(/is on with 14 tools/)).toBeTruthy();
  });

  it("reloads and removes", async () => {
    const { api } = setup([view()]);
    await userEvent.click(await screen.findByRole("button", { name: "Reload" }));
    await waitFor(() => expect(api.reload).toHaveBeenCalledWith("gmail"));
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith("gmail"));
  });

  it("closes", async () => {
    const { onClose } = setup([]);
    await userEvent.click(await screen.findByRole("button", { name: "Close" }));
    expect(onClose).toHaveBeenCalled();
  });
});

describe("<ConnectorsPanel> adding", () => {
  it("shows the steps and the warning of a ready-made one before anything is saved", async () => {
    setup([]);
    await userEvent.click(await addButton(/Gmail/));
    expect(screen.getByText(/Create the Google credentials/)).toBeTruthy();
    expect(screen.getByText(/Only approve a send you recognise/)).toBeTruthy();
    expect((screen.getByLabelText("Program") as HTMLInputElement).value).toBe("npx");
    expect((screen.getByLabelText(/Arguments/) as HTMLTextAreaElement).value).toBe("-y\n@gongrzhe/server-gmail-autoauth-mcp");
  });

  it("shows exactly what will run on the PIN page, then adds it with the PIN", async () => {
    const { api } = setup([]);
    await userEvent.click(await addButton(/Gmail/));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/start this program on your PC: npx -y @gongrzhe\/server-gmail-autoauth-mcp/)).toBeTruthy();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.add).toHaveBeenCalledWith({ id: "gmail", name: "Gmail", kind: "stdio", command: "npx", args: ["-y", "@gongrzhe/server-gmail-autoauth-mcp"], env: {} }, "123456"));
    expect(await screen.findByText(/Gmail is connected with 14 tools|saved but is not working/)).toBeTruthy();
  });

  it("can be confirmed with Enter on the keyboard", async () => {
    const { api } = setup([]);
    await userEvent.click(await addButton(/Gmail/));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.keyboard("123456{Enter}");
    await waitFor(() => expect(api.add).toHaveBeenCalled());
  });

  it("takes secret variables for a program, and secret headers for a server", async () => {
    const { api } = setup([]);
    await userEvent.click(await addButton(/Something else/));
    await userEvent.type(screen.getByLabelText("Name"), "My Mail");
    await userEvent.type(screen.getByLabelText("Program"), "node");
    await userEvent.type(screen.getByLabelText(/Arguments/), "server.js");
    await userEvent.type(screen.getByLabelText(/Secret variables/), "MAIL_TOKEN=abc123");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.add).toHaveBeenCalledWith({ id: "my-mail", name: "My Mail", kind: "stdio", command: "node", args: ["server.js"], env: { MAIL_TOKEN: "abc123" } }, "123456"));
    cleanup();

    const second = setup([]);
    await userEvent.click(await addButton(/Something else/));
    await userEvent.selectOptions(screen.getByLabelText("Type"), "http");
    await userEvent.type(screen.getByLabelText("Name"), "Web");
    await userEvent.type(screen.getByLabelText(/^Address/), "https://mcp.example.com/mcp");
    await userEvent.type(screen.getByLabelText(/Secret headers/), "Authorization: Bearer xyz");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(screen.getByText(/connect to https:\/\/mcp\.example\.com\/mcp/)).toBeTruthy();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(second.api.add).toHaveBeenCalledWith({ id: "web", name: "Web", kind: "http", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer xyz" } }, "123456"));
  });

  it("never prints the secret part of an address on the PIN page", async () => {
    setup([]);
    await userEvent.click(await addButton(/Something else/));
    await userEvent.selectOptions(screen.getByLabelText("Type"), "http");
    await userEvent.type(screen.getByLabelText("Name"), "Chrome shared");
    await userEvent.type(screen.getByLabelText(/^Address/), "http://127.0.0.1:8766/mcp?token=topsecret");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(document.body.textContent).not.toContain("topsecret");
  });

  it("asks for what is missing, and for a well-formed secret line", async () => {
    setup([]);
    await userEvent.click(await addButton(/Something else/));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Give it a name/);
    await userEvent.type(screen.getByLabelText("Name"), "Thing");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/program to start/);
    await userEvent.type(screen.getByLabelText("Program"), "x");
    await userEvent.type(screen.getByLabelText(/Secret variables/), "no equals sign");
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/NAME=value/);
  });

  it("shows a wrong PIN and a refusal, and stays on the PIN page with the PIN cleared", async () => {
    setup([], { add: vi.fn(async () => { throw new Error("Incorrect PIN"); }) });
    await userEvent.click(await addButton(/Gmail/));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await typePin("000000");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Incorrect PIN/);
    expect(screen.getByRole("button", { name: "Confirm" })).toHaveProperty("disabled", true);
  });

  it("goes back from the PIN page to the form with the preset still there", async () => {
    setup([]);
    await userEvent.click(await addButton(/Gmail/));
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(screen.getByText(/Create the Google credentials/)).toBeTruthy();
  });

  it("will not offer a ready-made one that is already added", async () => {
    setup([view()]);
    expect(await addButton(/Gmail/)).toHaveProperty("disabled", true);
    expect(await addButton(/Chrome/)).toHaveProperty("disabled", false);
    cleanup();
    setup([view({ id: "chrome", name: "Chrome control" })]);
    expect(await addButton(/Chrome/)).toHaveProperty("disabled", true);
  });
});

describe("parsing what was typed", () => {
  it("lines, variables and headers", () => {
    expect(parseLines(" a \n\n b\r\n")).toEqual(["a", "b"]);
    expect(parseEnv("A=1\nB = two=2")).toEqual({ A: "1", B: "two=2" });
    expect(() => parseEnv("nope")).toThrow(/NAME=value/);
    expect(parseHeaders("Authorization: Bearer a:b")).toEqual({ Authorization: "Bearer a:b" });
    expect(() => parseHeaders("nope")).toThrow(/Name: value/);
  });
});

describe("owner menu and the command", () => {
  it("has a Connectors button", async () => {
    const onConnectors = vi.fn();
    render(<OwnerMenu muted={false} onToggleMute={() => {}} onSignedOut={() => {}} onConnectors={onConnectors} />);
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Connectors" }));
    expect(onConnectors).toHaveBeenCalled();
    expect(screen.queryByRole("dialog", { name: /owner menu/i })).toBeNull();
  });
});

describe("Chrome control: one click", () => {
  it("is a Connect button, not a form; the other ready-made one still says Add", async () => {
    setup([]);
    expect((await addButton(/Chrome/)).textContent).toBe("Connect");
    expect((await addButton(/Gmail/)).textContent).toBe("Add");
  });

  it("when everything is installed it goes straight to the PIN, with no form to fill in", async () => {
    const { api } = setup([]);
    await userEvent.click(await addButton(/Chrome/));
    expect(await screen.findByText(/Friend will add Chrome control for you and start it\. It runs: npx -y chrome-control-mcp/)).toBeTruthy();
    expect(screen.queryByLabelText("Program")).toBeNull();
    expect(screen.queryByLabelText("Name")).toBeNull();
    expect(api.quickCheck).toHaveBeenCalledWith("chrome");
    expect(api.quickConnect).not.toHaveBeenCalled();
  });

  it("connects with the PIN alone, and says in words how it went", async () => {
    const { api } = setup([]);
    await userEvent.click(await addButton(/Chrome/));
    await screen.findByText(/Enter your PIN to continue/);
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    await waitFor(() => expect(api.quickConnect).toHaveBeenCalledWith("chrome", "123456"));
    expect(await screen.findByText(/Chrome control is on with 32 tools\. Your Chrome extension is connected/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(await screen.findByText("Connected")).toBeTruthy();
  });

  it("can be confirmed with Enter", async () => {
    const { api } = setup([]);
    await userEvent.click(await addButton(/Chrome/));
    await screen.findByText(/Enter your PIN to continue/);
    await userEvent.keyboard("123456{Enter}");
    await waitFor(() => expect(api.quickConnect).toHaveBeenCalledWith("chrome", "123456"));
  });

  it("when it is not installed, says so plainly and shows how to install it first", async () => {
    const { api } = setup([], { quickCheck: vi.fn(async () => NOT_READY) });
    await userEvent.click(await addButton(/Chrome/));
    expect(await screen.findByText(/Please install it first, then press Connect again/)).toBeTruthy();
    expect(screen.getByText("npx -y chrome-control-mcp setup")).toBeTruthy();
    expect(screen.getByText(/chrome:\/\/extensions, turn on Developer mode, click Load unpacked/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Set it up for me" })).toBeTruthy();
    expect(api.quickConnect).not.toHaveBeenCalled();
    expect(screen.queryByText(/Enter your PIN/)).toBeNull(); // no PIN is asked for something that cannot work yet
  });

  it("Check again moves on as soon as it has been installed by hand", async () => {
    let installed = false;
    const { api } = setup([], { quickCheck: vi.fn(async () => (installed ? READY : NOT_READY)) });
    await userEvent.click(await addButton(/Chrome/));
    await screen.findByText(/Please install it first/);
    installed = true;
    await userEvent.click(screen.getByRole("button", { name: "Check again" }));
    expect(await screen.findByText(/Friend will add Chrome control for you/)).toBeTruthy();
    expect(api.quickCheck).toHaveBeenCalledTimes(2);
  });

  it("Set it up for me installs in the background and then connects, with one PIN", async () => {
    const { api } = setup([], { quickCheck: vi.fn(async () => NOT_READY) });
    await userEvent.click(await addButton(/Chrome/));
    await userEvent.click(await screen.findByRole("button", { name: "Set it up for me" }));
    expect(await screen.findByText(/install Chrome control for you in the background, then connect it/)).toBeTruthy();
    expect(screen.getByText(/without touching Claude's settings or Chrome's shortcuts/)).toBeTruthy();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Install and connect" }));
    await waitFor(() => expect(api.quickInstall).toHaveBeenCalledWith("chrome", "123456"));
    await waitFor(() => expect(api.quickConnect).toHaveBeenCalledWith("chrome", "123456"));
    expect(await screen.findByText(/One step only you can do: load the extension/)).toBeTruthy();
    expect(screen.getByText(/Your Chrome extension is connected/)).toBeTruthy();
  });

  it("a failed install does not try to connect, shows what the installer said, and offers to try again", async () => {
    const { api } = setup([], {
      quickCheck: vi.fn(async () => NOT_READY),
      quickInstall: vi.fn(async () => ({ ok: false, output: "npm ERR! network offline", extensionFolder: null, message: "The install did not finish. You can run it yourself in a terminal: npx -y chrome-control-mcp setup" })),
    });
    await userEvent.click(await addButton(/Chrome/));
    await userEvent.click(await screen.findByRole("button", { name: "Set it up for me" }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Install and connect" }));
    expect(await screen.findByText(/The install did not finish/)).toBeTruthy();
    expect(screen.getByText(/network offline/)).toBeTruthy();
    expect(api.quickConnect).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("tells the owner when the extension still has to be switched on", async () => {
    setup([], { quickConnect: vi.fn(async () => ({ ...CONNECTED, extension: "off" as const, message: "Chrome control is on with 32 tools. But the Chrome extension is not connected yet. Click its icon in Chrome and switch it on." })) });
    await userEvent.click(await addButton(/Chrome/));
    await screen.findByText(/Enter your PIN/);
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/extension is not connected yet\. Click its icon in Chrome and switch it on/)).toBeTruthy();
  });

  it("shows a wrong PIN and stays on the PIN page with the PIN cleared", async () => {
    setup([], {
      quickConnect: vi.fn(async () => {
        throw new Error("Incorrect PIN");
      }),
    });
    await userEvent.click(await addButton(/Chrome/));
    await screen.findByText(/Enter your PIN/);
    await typePin("000000");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Incorrect PIN/);
    expect(screen.getByRole("button", { name: "Connect" })).toHaveProperty("disabled", true);
  });

  it("a connector that did not start says why", async () => {
    setup([], { quickConnect: vi.fn(async () => ({ ok: false, extension: "unknown" as const, connector: { id: "chrome", name: "Chrome control", status: "error", error: "spawn npx ENOENT", tools: 0 }, message: "Chrome control is saved, but it did not start: spawn npx ENOENT" })) });
    await userEvent.click(await addButton(/Chrome/));
    await screen.findByText(/Enter your PIN/);
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Connect" }));
    expect(await screen.findByText(/did not start: spawn npx ENOENT/)).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
  });

  it("a problem while checking goes back to the list with the reason", async () => {
    setup([], {
      quickCheck: vi.fn(async () => {
        throw new Error("Please sign in again.");
      }),
    });
    await userEvent.click(await addButton(/Chrome/));
    expect((await screen.findByRole("alert")).textContent).toMatch(/sign in again/i);
    expect(await screen.findByText("Connected")).toBeTruthy();
  });

  it("Back from the PIN page leaves everything as it was", async () => {
    const { api } = setup([]);
    await userEvent.click(await addButton(/Chrome/));
    await screen.findByText(/Enter your PIN/);
    await userEvent.click(screen.getByRole("button", { name: "Back" }));
    expect(await screen.findByText("Connected")).toBeTruthy();
    expect(api.quickConnect).not.toHaveBeenCalled();
  });
});
