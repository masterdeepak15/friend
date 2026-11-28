import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MailboxesPanel } from "./MailboxesPanel";
import type { MailAccountView, MailApi } from "./mailApi";

afterEach(cleanup);

const acct = (over: Partial<MailAccountView> = {}): MailAccountView => ({ id: 1, name: "Support", address: "support@corp.com", imap: { host: "imap.corp.com", port: 993, tls: true }, smtp: { host: "smtp.corp.com", port: 465, secure: true }, username: "support@corp.com", owners: ["boss@corp.com"], systems: [], ladder: { send: "ask", reply: "ask", forward: "ask" }, enabled: true, status: "online", statusDetail: "", hasPassword: true, ...over });

function setup(handlers: Awaited<ReturnType<NonNullable<MailApi["handlers"]>>> | null) {
  const setHandler = vi.fn(async () => {});
  const api: MailApi = {
    list: vi.fn(async () => [acct()]),
    add: vi.fn(async () => acct()),
    update: vi.fn(async () => acct()),
    setLadder: vi.fn(async () => acct()),
    test: vi.fn(async () => ({ ok: true })),
    remove: vi.fn(async () => {}),
    ...(handlers ? { handlers: vi.fn(async () => handlers), setHandler } : {}),
  };
  render(<MailboxesPanel api={api} pollMs={0} />);
  return { setHandler };
}

describe("who handles a mailbox", () => {
  it("offers the assistant and each crew worker, shows who has it now, and changes it", async () => {
    const { setHandler } = setup({ workers: [{ id: "ada", name: "Ada", role: "support" }], routes: [] });
    const select = (await screen.findByLabelText("Handled by, Support")) as HTMLSelectElement;
    expect(select.value).toBe("");
    expect([...select.options].map((o) => o.text)).toEqual(["The assistant", "Ada (crew, support)"]);
    await userEvent.selectOptions(select, "ada");
    await waitFor(() => expect(setHandler).toHaveBeenCalledWith(1, "ada"));
    await userEvent.selectOptions(select, "");
    await waitFor(() => expect(setHandler).toHaveBeenLastCalledWith(1, null)); // back to the assistant
  });

  it("shows the worker that has it now", async () => {
    setup({ workers: [{ id: "ada", name: "Ada", role: "support" }], routes: [{ kind: "mail", key: "1", worker: "ada" }] });
    expect(((await screen.findByLabelText("Handled by, Support")) as HTMLSelectElement).value).toBe("ada");
  });

  it("is not shown when there is no crew", async () => {
    setup({ workers: [], routes: [] });
    await screen.findByText("Support");
    expect(screen.queryByLabelText(/Handled by/)).toBeNull();
  });

  it("is not shown by a screen that has no crew at all", async () => {
    setup(null);
    await screen.findByText("Support");
    expect(screen.queryByLabelText(/Handled by/)).toBeNull();
  });
});
