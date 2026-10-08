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
  connector: { id: "chrome", name: "Chrome control", kind: "stdio" as const, command: "chrome-control-mcp", args: [] },
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

function setup(connectors: ConnectorView[] = [], overrides: Partial<ConnectorsApi> = {}) {
  let state: ConnectorList = { connectors, presets: [chromePreset, gmailPreset] };
  const api: ConnectorsApi = {
    list: vi.fn(async () => state),
    add: vi.fn(async (c) => view({ id: c.id, name: c.name })),
    setEnabled: vi.fn(async (id, enabled) => view({ id, enabled, status: enabled ? "ready" : "off" })),
    reload: vi.fn(async (id) => view({ id })),
    remove: vi.fn(async () => {}),
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
  return within(li).getByRole("button", { name: "Add" });
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
    await userEvent.click(await addButton(/Chrome/));
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
    await userEvent.click(await addButton(/Chrome/));
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
