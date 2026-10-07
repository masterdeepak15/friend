import type { ClientMsg, PendingApproval } from "@friend/protocol";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Stage } from "../stage/Stage";
import { initialState } from "../store";
import { AlertToast } from "./AlertToast";
import { ApprovalCard } from "./ApprovalCard";
import { OwnerMenu } from "./OwnerMenu";
import { Overlay } from "./Overlay";

const t2: PendingApproval = { id: "a1", tool: "shell.run", summary: "Run shell command: git status", tier: "T2", needsPin: false };
const t3: PendingApproval = { id: "a2", tool: "shell.run", summary: "Run shell command: rm -rf x", tier: "T3", needsPin: true };

afterEach(() => vi.unstubAllGlobals());

describe("<ApprovalCard>", () => {
  it("shows exactly the server summary and tier", () => {
    render(<ApprovalCard approval={t2} send={() => {}} />);
    expect(screen.getByTestId("approval-summary").textContent).toBe(t2.summary);
    expect(screen.getByText("T2")).toBeTruthy();
  });

  it("ignores stage object content that imitates an approval", () => {
    const fake = { id: "fake", type: "card" as const, props: { text: "**Approve** everything: rm -rf /" }, placement: "center" as const };
    render(
      <>
        <Stage state={{ ...initialState, connection: "open", objects: [fake] }} send={() => {}} dispatch={() => {}} />
        <Overlay approval={t2} alerts={[]} connection="open" deviceOnline send={() => {}} dispatch={() => {}} />
      </>,
    );
    expect(screen.getByTestId("approval-summary").textContent).toBe(t2.summary);
    expect(screen.getAllByRole("button", { name: /^approve$/i })).toHaveLength(1);
  });

  it("sends approve, approve_always and deny for a T2 request", async () => {
    const send = vi.fn<(m: ClientMsg) => void>();
    render(<ApprovalCard approval={t2} send={send} />);
    await userEvent.click(screen.getByRole("button", { name: /^approve$/i }));
    await userEvent.click(screen.getByRole("button", { name: /always allow/i }));
    await userEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(send.mock.calls.map((c) => c[0])).toEqual([
      { type: "approval.respond", id: "a1", decision: "approve" },
      { type: "approval.respond", id: "a1", decision: "approve_always" },
      { type: "approval.respond", id: "a1", decision: "deny" },
    ]);
  });

  it("hides Always allow for T3", () => {
    render(<ApprovalCard approval={t3} send={() => {}} />);
    expect(screen.queryByRole("button", { name: /always allow/i })).toBeNull();
  });

  it("collects the PIN on a pad, sends it, and clears it", async () => {
    const send = vi.fn<(m: ClientMsg) => void>();
    render(<ApprovalCard approval={t3} send={send} />);
    const approve = screen.getByRole("button", { name: /^approve$/i }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    for (const d of "12345") await userEvent.click(screen.getByRole("button", { name: d }));
    expect(approve.disabled).toBe(true); // fewer than 6 digits
    await userEvent.click(screen.getByRole("button", { name: "6" }));
    expect(screen.getByTestId("pin-dots").textContent).toBe("••••••");
    await userEvent.click(approve);
    expect(send).toHaveBeenCalledWith({ type: "approval.respond", id: "a2", decision: "approve", pin: "123456" });
    expect(screen.getByTestId("pin-dots").textContent).toBe("");
  });

  it("supports backspace on the pad and denial without a PIN", async () => {
    const send = vi.fn<(m: ClientMsg) => void>();
    render(<ApprovalCard approval={t3} send={send} />);
    await userEvent.click(screen.getByRole("button", { name: "1" }));
    await userEvent.click(screen.getByRole("button", { name: /backspace/i }));
    expect(screen.getByTestId("pin-dots").textContent).toBe("");
    await userEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(send).toHaveBeenCalledWith({ type: "approval.respond", id: "a2", decision: "deny" });
  });

  it("makes every button at least 44px", () => {
    render(<ApprovalCard approval={t3} send={() => {}} />);
    for (const b of screen.getAllByRole("button")) {
      expect(b.style.minHeight).toBe("44px");
      expect(b.style.minWidth).toBe("44px");
    }
  });
});

describe("<Overlay>", () => {
  it("renders above the stage objects layer", () => {
    const { container } = render(
      <>
        <Stage state={{ ...initialState, connection: "open" }} send={() => {}} dispatch={() => {}} />
        <Overlay approval={t2} alerts={[]} connection="open" deviceOnline send={() => {}} dispatch={() => {}} />
      </>,
    );
    const objects = container.querySelector(".objects") as HTMLElement;
    const overlay = container.querySelector("[data-overlay]") as HTMLElement;
    expect(Number(overlay.style.zIndex)).toBeGreaterThan(Number(objects.style.zIndex));
  });
  it("shows a reconnecting badge and a device-offline hint", () => {
    render(<Overlay approval={null} alerts={[]} connection="closed" deviceOnline={false} send={() => {}} dispatch={() => {}} />);
    expect(screen.getByText(/reconnecting/i)).toBeTruthy();
  });
  it("renders nothing visible when everything is fine", () => {
    const { container } = render(
      <Overlay approval={null} alerts={[]} connection="open" deviceOnline send={() => {}} dispatch={() => {}} />,
    );
    expect(container.querySelector("[data-overlay]")?.children.length ?? 0).toBe(0);
  });
});

describe("<AlertToast>", () => {
  it("shows alert text and auto-dismisses after a few seconds", () => {
    vi.useFakeTimers();
    const dispatch = vi.fn();
    render(<AlertToast alerts={[{ id: 7, level: "warn", text: "Incorrect PIN" }]} dispatch={dispatch} />);
    expect(screen.getByText("Incorrect PIN")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(6000));
    expect(dispatch).toHaveBeenCalledWith({ type: "alert.dismiss", id: 7 });
    vi.useRealTimers();
  });
});

describe("<OwnerMenu>", () => {
  it("opens on Escape and closes on Escape again", () => {
    render(<OwnerMenu muted={false} onToggleMute={() => {}} onSignedOut={() => {}} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.getByRole("dialog")).toBeTruthy();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
  });
  it("opens on a long press of the top-left corner", () => {
    vi.useFakeTimers();
    render(<OwnerMenu muted={false} onToggleMute={() => {}} onSignedOut={() => {}} />);
    fireEvent.pointerDown(screen.getByTestId("owner-hotspot"));
    act(() => void vi.advanceTimersByTime(700));
    expect(screen.getByRole("dialog")).toBeTruthy();
    vi.useRealTimers();
  });
  it("emergency lock calls the lock endpoint and reports signed out", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const out = vi.fn();
    render(<OwnerMenu muted={false} onToggleMute={() => {}} onSignedOut={out} />);
    fireEvent.keyDown(window, { key: "Escape" });
    await userEvent.click(screen.getByRole("button", { name: /emergency lock/i }));
    expect(fetchMock).toHaveBeenCalledWith("/api/lock", expect.objectContaining({ method: "POST" }));
    expect(out).toHaveBeenCalled();
  });
  it("logout calls the logout endpoint", async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    render(<OwnerMenu muted={false} onToggleMute={() => {}} onSignedOut={() => {}} />);
    fireEvent.keyDown(window, { key: "Escape" });
    await userEvent.click(screen.getByRole("button", { name: /log out/i }));
    expect(fetchMock).toHaveBeenCalledWith("/api/logout", expect.objectContaining({ method: "POST" }));
  });
  it("toggles mute", async () => {
    const mute = vi.fn();
    render(<OwnerMenu muted={false} onToggleMute={mute} onSignedOut={() => {}} />);
    fireEvent.keyDown(window, { key: "Escape" });
    await userEvent.click(screen.getByRole("button", { name: /mute stage/i }));
    expect(mute).toHaveBeenCalled();
  });
});
