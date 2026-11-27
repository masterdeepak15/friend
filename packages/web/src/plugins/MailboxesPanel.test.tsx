import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationConfig } from "./IntegrationConfig";
import type { IntegrationEntry, PluginList, PluginsApi } from "./pluginsApi";
import { PluginsPanel } from "./PluginsPanel";
import { MailboxesPanel } from "./MailboxesPanel";
import type { MailAccountView, MailApi } from "./mailApi";

afterEach(cleanup);

const acct = (over: Partial<MailAccountView> = {}): MailAccountView => ({ id: 1, name: "Support", address: "support@corp.com", imap: { host: "imap.corp.com", port: 993, tls: true }, smtp: { host: "smtp.corp.com", port: 465, secure: true }, username: "support@corp.com", owners: ["boss@corp.com"], systems: [], ladder: { send: "ask", reply: "ask", forward: "ask" }, enabled: true, status: "online", statusDetail: "", hasPassword: true, ...over });

function setup(list: MailAccountView[] = [acct()]) {
  const api: MailApi = {
    list: vi.fn(async () => list),
    add: vi.fn(async (input) => acct({ id: 2, name: input.name })),
    update: vi.fn(async () => acct()),
    setLadder: vi.fn(async () => acct()),
    test: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => {}),
  };
  const onBack = vi.fn();
  render(<MailboxesPanel api={api} pollMs={0} onBack={onBack} />);
  return { api, onBack };
}
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};

describe("the list of mailboxes", () => {
  it("shows each mailbox with how it is doing, why when it is not, and who may give it orders", async () => {
    setup([acct(), acct({ id: 2, name: "Sales", status: "needs-sign-in", statusDetail: "imap.corp.com refused the sign-in.", owners: [] })]);
    const row = (await screen.findByText("Support")).closest("li")!;
    expect(within(row).getByText("online")).toBeTruthy();
    expect(row.textContent).toContain("boss@corp.com");
    const sales = screen.getByText("Sales").closest("li")!;
    expect(within(sales).getByText("needs sign-in")).toBeTruthy();
    expect(sales.textContent).toContain("refused the sign-in");
    expect(sales.textContent).toContain("nobody yet");
  });

  it("says what to do when there is none", async () => {
    setup([]);
    expect(await screen.findByText(/No mailboxes yet/)).toBeTruthy();
  });

  it("tests the saved login and says the result", async () => {
    const { api } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Test login" }));
    await waitFor(() => expect(api.test).toHaveBeenCalledWith(1));
    expect(await screen.findByText(/the login works/)).toBeTruthy();
  });
});

describe("adding a mailbox", () => {
  it("fills the server settings from a provider, keeps the password out of sight, asks for the PIN, then adds it", async () => {
    const { api } = setup([]);
    await userEvent.click(await screen.findByRole("button", { name: "Add a mailbox" }));
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "Gmail" }));
    expect(screen.getByText(/app password/i)).toBeTruthy();
    expect((screen.getByLabelText("IMAP server") as HTMLInputElement).value).toBe("imap.gmail.com");
    expect((screen.getByLabelText("SMTP server") as HTMLInputElement).value).toBe("smtp.gmail.com");
    expect((screen.getByLabelText("Password") as HTMLInputElement).type).toBe("password");
    await userEvent.type(screen.getByLabelText("Name of the mailbox"), "Support");
    await userEvent.type(screen.getByLabelText("Email address"), "support@corp.com");
    await userEvent.type(screen.getByLabelText("Password"), "s3cret-app-pw");
    await userEvent.type(screen.getByLabelText("Your addresses"), "boss@corp.com");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.add).toHaveBeenCalledWith(expect.objectContaining({ name: "Support", address: "support@corp.com", username: "support@corp.com", owners: ["boss@corp.com"], imap: { host: "imap.gmail.com", port: 993, tls: true } }), "s3cret-app-pw", "123456"));
  });

  it("will not continue without an address of the owner (nobody could give it an order)", async () => {
    setup([]);
    await userEvent.click(await screen.findByRole("button", { name: "Add a mailbox" }));
    await userEvent.click(screen.getByRole("button", { name: "Gmail" }));
    await userEvent.type(screen.getByLabelText("Name of the mailbox"), "Support");
    await userEvent.type(screen.getByLabelText("Email address"), "support@corp.com");
    await userEvent.type(screen.getByLabelText("Password"), "pw");
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("shows the reason when the login is refused and stays on the PIN step", async () => {
    const { api } = setup([]);
    (api.add as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("imap.gmail.com refused the sign-in."));
    await userEvent.click(await screen.findByRole("button", { name: "Add a mailbox" }));
    await userEvent.click(screen.getByRole("button", { name: "Gmail" }));
    await userEvent.type(screen.getByLabelText("Name of the mailbox"), "S");
    await userEvent.type(screen.getByLabelText("Email address"), "s@corp.com");
    await userEvent.type(screen.getByLabelText("Password"), "bad");
    await userEvent.type(screen.getByLabelText("Your addresses"), "me@corp.com");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "imap.gmail.com refused the sign-in.");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
  });
});

describe("changing, what it may send, and removing", () => {
  it("changes a mailbox without asking for the password again", async () => {
    const { api } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Change" }));
    expect((screen.getByLabelText("Password") as HTMLInputElement).value).toBe("");
    await userEvent.type(screen.getByLabelText("Your addresses"), "{enter}me@home.org");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.update).toHaveBeenCalledWith(1, expect.objectContaining({ owners: ["boss@corp.com", "me@home.org"] }), undefined, "123456"));
  });

  it("lets the owner allow replies to go by themselves, with the PIN", async () => {
    const { api } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "What it may send" }));
    expect(screen.getByText(/always asks/)).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText("Replies"), "auto");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.setLadder).toHaveBeenCalledWith(1, { send: "ask", reply: "auto", forward: "ask" }, "123456"));
  });

  it("asks before removing, needs the PIN, and goes back to the plugins list", async () => {
    const { api, onBack } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Remove" }));
    expect(screen.getByText(/saved password/)).toBeTruthy();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.remove).toHaveBeenCalledWith(1, "123456"));
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalled();
  });
});

describe("Mailboxes on the plugins screen", () => {
  const entry = (over: Partial<IntegrationEntry> = {}): IntegrationEntry => ({ id: "mail", name: "Mailboxes", description: "Gives Friend email accounts of its own.", installed: false, enabled: false, state: "not-installed", detail: "", steps: [{ text: "Switch the plugin on.", done: false }], ...over });
  const listApi = (integrations: IntegrationEntry[]): PluginsApi => {
    const list: PluginList = { installed: [], catalog: [], integrations };
    return { list: vi.fn(async () => list), install: vi.fn(async () => {}), setEnabled: vi.fn(async () => {}), remove: vi.fn(async () => {}), reload: vi.fn(async () => {}) };
  };

  it("is offered under Available and installed with the PIN", async () => {
    const api = listApi([entry()]);
    render(<PluginsPanel api={api} onClose={() => {}} />);
    const card = (await screen.findByText("Mailboxes")).closest("li")!;
    await userEvent.click(within(card).getByRole("button", { name: "Install" }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.install).toHaveBeenCalledWith("mail", "123456"));
  });

  it("opens the mailboxes from Configure, with no Save button", async () => {
    const mail: MailApi = { list: vi.fn(async () => [acct()]), add: vi.fn(), update: vi.fn(), setLadder: vi.fn(), test: vi.fn(), remove: vi.fn() };
    render(<IntegrationConfig integration={entry({ installed: true, enabled: true, state: "online", detail: "1 of 1 mailbox online." })} onBack={() => {}} mailApi={mail} />);
    expect(await screen.findByText("Support")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add a mailbox" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Save/ })).toBeNull();
  });
});
