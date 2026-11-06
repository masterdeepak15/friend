import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AuditLocked, type AuditApi, type AuditNode, type AuditRow } from "./auditApi";
import { AuditTab } from "./AuditTab";

afterEach(cleanup);

const row = (over: Partial<AuditRow> = {}): AuditRow => ({ id: 1, ts: Date.UTC(2026, 10, 6, 9, 30), actorKind: "owner", actorId: "owner", requestId: "chat-1", parentId: null, kind: "request", target: "chat", outcome: "done", detail: { text: "hello" }, legacy: false, ...over });
function makeApi(over: Partial<AuditApi> = {}): AuditApi {
  return {
    unlock: vi.fn(async () => {}),
    search: vi.fn(async () => ({ rows: [row(), row({ id: 2, kind: "tool.end", actorKind: "assistant", actorId: "", target: "fs.read", outcome: "failed" })], counts: { total: 2, refused: 0, failed: 1 } })),
    tree: vi.fn(async (): Promise<AuditNode[]> => []),
    attention: vi.fn(async () => [row({ id: 7, kind: "approval.decided", outcome: "refused" })]),
    verify: vi.fn(async () => ({ ok: true as const, rows: 12, lastHash: "ab".repeat(32) })),
    status: vi.fn(async () => ({ rows: 12, lastId: 12, lastSeal: { at: Date.UTC(2026, 10, 6, 9, 0), text: "Friend audit seal ..." }, keepDays: 90, workers: [{ id: "Dev (be8d8dca)", name: "Dev (be8d8dca)", last: 1 }] })),
    download: vi.fn(async () => {}),
    ...over,
  };
}
const enterPin = async (pin = "123456") => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
  await userEvent.click(screen.getByRole("button", { name: /open|unlock/i }));
};
const open = async (api = makeApi()) => {
  render(<AuditTab api={api} />);
  await enterPin();
  await screen.findByRole("table");
  return api;
};

describe("the audit screen", () => {
  it("asks for the PIN first and shows nothing else until it is given", async () => {
    const api = makeApi();
    render(<AuditTab api={api} />);
    expect(screen.getByText(/PIN/)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
    expect(api.search).not.toHaveBeenCalled();
    await enterPin();
    expect(api.unlock).toHaveBeenCalledWith("123456");
    expect(await screen.findByRole("table")).toBeTruthy();
    expect(api.search).toHaveBeenCalled();
  });

  it("a wrong PIN says so and stays locked", async () => {
    const api = makeApi({ unlock: vi.fn(async () => { throw new Error("Incorrect PIN"); }) });
    render(<AuditTab api={api} />);
    await enterPin("000000");
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Incorrect PIN");
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("lists the entries with who, what, target and result, and the totals", async () => {
    await open();
    const rows = screen.getAllByRole("row").map((r) => r.textContent ?? "");
    expect(rows.some((t) => t.includes("owner") && t.includes("request") && t.includes("done"))).toBe(true);
    expect(rows.some((t) => t.includes("fs.read") && t.includes("failed"))).toBe(true);
    expect(screen.getByText("2 entries, 0 refused, 1 failed")).toBeTruthy();
  });

  it("the filters change what is asked for", async () => {
    const api = await open();
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "approvals");
    await waitFor(() => expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ group: "approvals" })));
    await userEvent.selectOptions(screen.getByLabelText("Who"), "worker");
    await waitFor(() => expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ actorKind: "worker", group: "approvals" })));
    await userEvent.selectOptions(screen.getByLabelText("Result"), "refused");
    await waitFor(() => expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ outcome: "refused" })));
    await userEvent.type(screen.getByLabelText("Search"), "npm");
    await waitFor(() => expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ q: "npm" })));
    await userEvent.selectOptions(screen.getByLabelText("When"), "1h");
    await waitFor(() => expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ from: expect.any(Number) })));
  });

  it("'Needs attention' and each worker's timeline call their own queries", async () => {
    const api = await open();
    await userEvent.click(screen.getByRole("button", { name: "Needs attention" }));
    await waitFor(() => expect(api.attention).toHaveBeenCalled());
    expect(await screen.findByText("approval.decided")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Dev (be8d8dca)" }));
    await waitFor(() => expect(api.search).toHaveBeenLastCalledWith(expect.objectContaining({ actorId: "Dev (be8d8dca)" })));
  });

  it("'Follow this request' shows everything a request caused, in order, nested", async () => {
    const child = row({ id: 5, kind: "worker.tool", actorKind: "worker", actorId: "Dev (be8d8dca)", target: "Bash", requestId: "run-1", parentId: "chat-1" });
    const api = await open(makeApi({ tree: vi.fn(async () => [{ row: row({ id: 1 }), children: [] }, { row: row({ id: 3, kind: "tool.start", target: "office.assign" }), children: [{ row: child, children: [] }] }]) }));
    await userEvent.click(screen.getAllByRole("button", { name: /follow/i })[0]!);
    await waitFor(() => expect(api.tree).toHaveBeenCalledWith("chat-1"));
    const panel = await screen.findByRole("region", { name: /request/i });
    const kinds = within(panel).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(kinds[0]).toContain("request");
    expect(kinds[1]).toContain("tool.start");
    expect(kinds[2]).toContain("worker.tool");
  });

  it("'Verify chain' says OK, or names the broken entry, and shows the last seal", async () => {
    const api = await open();
    await userEvent.click(screen.getByRole("button", { name: /verify chain/i }));
    expect(await screen.findByText(/Chain OK/)).toBeTruthy();
    expect(screen.getByText(/Last seal/)).toBeTruthy();
    (api.verify as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, brokenAt: 7, reason: "hash" });
    await userEvent.click(screen.getByRole("button", { name: /verify chain/i }));
    expect(await screen.findByText(/broken at entry 7/i)).toBeTruthy();
  });

  it("logged text is only ever shown as text: markup in it creates no elements", async () => {
    const evil = "<img src=x onerror=alert(1)> <script>alert(2)</script>";
    const { container } = render(<AuditTab api={makeApi({ search: vi.fn(async () => ({ rows: [row({ target: evil, detail: { text: evil } })], counts: { total: 1, refused: 0, failed: 0 } })) })} />);
    await enterPin();
    await screen.findByRole("table");
    expect(container.querySelector("img")).toBeNull();
    expect(container.querySelector("script")).toBeNull();
    expect(container.textContent).toContain("<img src=x onerror=alert(1)>");
  });

  it("a long value is cut with 'show more', and shown whole when asked", async () => {
    const long = "x".repeat(900);
    render(<AuditTab api={makeApi({ search: vi.fn(async () => ({ rows: [row({ detail: { text: long } })], counts: { total: 1, refused: 0, failed: 0 } })) })} />);
    await enterPin();
    await screen.findByRole("table");
    expect(document.body.textContent).not.toContain(long);
    await userEvent.click(screen.getByRole("button", { name: /show more/i }));
    expect(document.body.textContent).toContain(long);
  });

  it("the export buttons ask for the range as a file", async () => {
    const api = await open();
    await userEvent.click(screen.getByRole("button", { name: "CSV" }));
    await userEvent.click(screen.getByRole("button", { name: "Report (HTML)" }));
    await userEvent.click(screen.getByRole("button", { name: "JSON" }));
    expect(api.download).toHaveBeenNthCalledWith(1, expect.any(Object), "csv");
    expect(api.download).toHaveBeenNthCalledWith(2, expect.any(Object), "html");
    expect(api.download).toHaveBeenNthCalledWith(3, expect.any(Object), "json");
  });

  it("when the area locks again, it goes back to the PIN", async () => {
    const search = vi.fn().mockResolvedValueOnce({ rows: [row()], counts: { total: 1, refused: 0, failed: 0 } }).mockRejectedValue(new AuditLocked());
    render(<AuditTab api={makeApi({ search })} />);
    await enterPin();
    await screen.findByRole("table");
    await userEvent.selectOptions(screen.getByLabelText("Kind"), "tools");
    expect(await screen.findByText(/Enter your PIN/i)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});
