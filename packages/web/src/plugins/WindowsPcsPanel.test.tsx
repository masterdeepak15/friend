import { NO_PC_PERMISSIONS } from "@friend/protocol";
import { cleanup, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WindowsPcsPanel, statusLine } from "./WindowsPcsPanel";
import type { PcView, PcsApi } from "./pcsApi";

afterEach(cleanup);

const pc = (over: Partial<PcView> = {}): PcView => ({ id: 1, name: "Office PC", os: "Windows 11", host: "OFFICE-PC", online: true, permissions: { ...NO_PC_PERMISSIONS, control: true, screen: true }, status: { state: "idle", at: 1 }, lastSeen: Date.now(), revoked: false, lease: null, ...over });

function setup(pcs: PcView[] = [pc()]) {
  const api: PcsApi = {
    list: vi.fn(async () => pcs),
    add: vi.fn(async (name) => ({ pc: pc({ id: 2, name, online: false, os: "" }), enrollmentId: "enr", install: { command: `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://maya.example.com/api/pc/install.ps1?enrollment=enr' | iex"`, ps1Url: "https://maya.example.com/api/pc/install.ps1?enrollment=enr", cmdUrl: "https://maya.example.com/api/pc/install.cmd?enrollment=enr" }, agentMissing: false })),
    reissue: vi.fn(async () => ({ enrollmentId: "enr2", install: { command: "powershell ... enr2", ps1Url: "", cmdUrl: "https://x/install.cmd?enrollment=enr2" }, agentMissing: false })),
    setPermissions: vi.fn(async () => {}),
    revoke: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    control: vi.fn(async () => {}),
  };
  const onBack = vi.fn();
  render(<WindowsPcsPanel api={api} pollMs={0} onBack={onBack} />);
  return { api, onBack };
}
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};

describe("the list of Windows PCs", () => {
  it("shows each PC with whether it is online, what it is doing, its task and its system", async () => {
    setup([pc({ status: { state: "controlling", task: "update the report", last: "typed in Notepad", at: 1, sessions: 2 }, lease: { until: null, paused: false } }), pc({ id: 2, name: "Home", online: false, lastSeen: Date.now() - 3 * 3600_000, os: "Windows 10", host: "HOME" })]);
    const office = await screen.findByText("Office PC");
    const row = office.closest("li")!;
    expect(within(row).getByText("online")).toBeTruthy();
    expect(row.textContent).toContain("controlling");
    expect(row.textContent).toContain("control session running");
    expect(row.textContent).toContain("task: update the report");
    expect(row.textContent).toContain("2 terminals");
    const home = screen.getByText("Home").closest("li")!;
    expect(within(home).getByText("offline")).toBeTruthy();
    expect(home.textContent).toContain("last seen 3 h ago");
  });

  it("says what to do when there are no PCs", async () => {
    setup([]);
    expect(await screen.findByText(/No PCs yet/)).toBeTruthy();
  });

  it("describes a paused session as taken over by the person", () => {
    expect(statusLine(pc({ lease: { until: null, paused: true } }))).toContain("control paused (you took over)");
  });
});

describe("adding a PC", () => {
  it("asks for a name and what it may do (all off), then the PIN, then shows the command to copy and the file to download", async () => {
    const { api } = setup([]);
    await userEvent.click(await screen.findByRole("button", { name: "Add a PC" }));
    expect((screen.getByRole("button", { name: "Continue" }) as HTMLButtonElement).disabled).toBe(true);
    for (const cb of screen.getAllByRole("checkbox")) expect((cb as HTMLInputElement).checked).toBe(false);
    await userEvent.type(screen.getByLabelText("Name of the PC"), "Shop PC");
    await userEvent.click(screen.getByRole("checkbox", { name: /Control the screen/ }));
    await userEvent.type(screen.getByLabelText("Folders"), "D:\\shop");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.add).toHaveBeenCalledWith("Shop PC", expect.objectContaining({ control: true, shell: false, folders: ["D:\\shop"] }), "123456"));
    const cmd = await screen.findByTestId("pc-command");
    expect(cmd.textContent).toContain("install.ps1?enrollment=enr");
    expect(screen.getByRole("link", { name: /Download the file/ }).getAttribute("href")).toContain("install.cmd?enrollment=enr");
    expect(screen.getByText(/does not need administrator rights/)).toBeTruthy();
  });

  it("says plainly when this Friend has no agent file to give", async () => {
    const { api } = setup([]);
    (api.add as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ pc: pc({ id: 3 }), enrollmentId: "e", install: null, agentMissing: true });
    await userEvent.click(await screen.findByRole("button", { name: "Add a PC" }));
    await userEvent.type(screen.getByLabelText("Name of the PC"), "X");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByText(/no PC agent built yet/)).toBeTruthy();
  });

  it("shows the reason when Friend refuses (for example a wrong PIN) and stays on the PIN step", async () => {
    const { api } = setup([]);
    (api.add as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Incorrect PIN"));
    await userEvent.click(await screen.findByRole("button", { name: "Add a PC" }));
    await userEvent.type(screen.getByLabelText("Name of the PC"), "X");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    await typePin("000000");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(await screen.findByRole("alert")).toHaveProperty("textContent", "Incorrect PIN");
    expect(screen.getByRole("button", { name: "Confirm" })).toBeTruthy();
  });
});

describe("what a PC may do, control, and revoking", () => {
  it("saves new permissions with the PIN", async () => {
    const { api } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Permissions" }));
    await userEvent.click(screen.getByRole("checkbox", { name: /Commands and terminals/ }));
    await userEvent.selectOptions(screen.getByLabelText("Files"), "read");
    await userEvent.click(screen.getByRole("button", { name: "Save" }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.setPermissions).toHaveBeenCalledWith(1, expect.objectContaining({ shell: true, files: "read", control: true }), "123456"));
  });

  it("starts a control session for a chosen time, and stops it", async () => {
    const { api } = setup();
    await userEvent.selectOptions(await screen.findByLabelText("Minutes for Office PC"), "60");
    await userEvent.click(screen.getByRole("button", { name: "Start control" }));
    await waitFor(() => expect(api.control).toHaveBeenCalledWith(1, "start", 60));
    cleanup();
    const again = setup([pc({ lease: { until: null, paused: false } })]);
    await userEvent.click(await screen.findByRole("button", { name: "Stop control" }));
    await waitFor(() => expect(again.api.control).toHaveBeenCalledWith(1, "stop"));
  });

  it("offers control only for a PC that is online and allowed", async () => {
    setup([pc({ online: false }), pc({ id: 2, name: "No control", permissions: NO_PC_PERMISSIONS })]);
    await screen.findByText("Office PC");
    expect(screen.queryByRole("button", { name: "Start control" })).toBeNull();
  });

  it("asks before revoking, needs the PIN, and a revoked PC can only be removed", async () => {
    const { api } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Revoke" }));
    expect(screen.getByText(/signed out at once/)).toBeTruthy();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(api.revoke).toHaveBeenCalledWith(1, "123456"));
    cleanup();
    const revoked = setup([pc({ revoked: true, online: false })]);
    expect(await screen.findByText(/Signed out/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Permissions" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Remove" }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: "Confirm" }));
    await waitFor(() => expect(revoked.api.remove).toHaveBeenCalledWith(1, "123456"));
  });

  it("goes back to the plugins list", async () => {
    const { onBack } = setup();
    await userEvent.click(await screen.findByRole("button", { name: "Back" }));
    expect(onBack).toHaveBeenCalled();
  });
});
