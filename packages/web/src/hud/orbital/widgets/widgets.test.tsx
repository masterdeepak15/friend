import type { PendingApproval } from "@friend/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalWidget } from "./ApprovalWidget";
import { BudgetWidget } from "./BudgetWidget";
import { FeedWidget } from "./FeedWidget";
import { TicketsWidget } from "./TicketsWidget";
import { VoiceWidget } from "./VoiceWidget";

afterEach(cleanup);

const levels = (c: HTMLElement) => [...c.querySelectorAll("rect.ob-eq")].map((r) => Number((r as unknown as HTMLElement).style.getPropertyValue("--lv")));

describe("VoiceWidget", () => {
  it("draws 16 bars that stay small but alive when there is no sound", () => {
    const { container } = render(<VoiceWidget level={0} mode="idle" />);
    const l = levels(container);
    expect(l).toHaveLength(16);
    expect(Math.max(...l)).toBeLessThanOrEqual(0.25);
    expect(Math.min(...l)).toBeGreaterThanOrEqual(0.06);
  });

  it("rises with the sound and names what the voice is doing", () => {
    const { container } = render(<VoiceWidget level={1} mode="listening" />);
    expect(Math.max(...levels(container))).toBeGreaterThan(0.9);
    expect(screen.getByText(/listening/i)).toBeTruthy();
  });
});

describe("FeedWidget", () => {
  it("shows the newest lines, newest last, and what Friend is doing", () => {
    render(<FeedWidget lines={[{ role: "user", text: "hello" }, { role: "assistant", text: "hi there" }]} activity="Thinking" busy />);
    expect(screen.getByText(/hi there/)).toBeTruthy();
    expect(screen.getByText(/Thinking/)).toBeTruthy();
  });

  it("keeps only the last eight lines", () => {
    const lines = Array.from({ length: 20 }, (_, i) => ({ role: "user" as const, text: `line ${i}` }));
    render(<FeedWidget lines={lines} activity={null} busy={false} />);
    expect(screen.queryByText(/line 11\b/)).toBeNull();
    expect(screen.getByText(/line 12\b/)).toBeTruthy();
    expect(screen.getByText(/line 19\b/)).toBeTruthy();
  });

  it("says so when there is nothing yet", () => {
    render(<FeedWidget lines={[]} activity={null} busy={false} />);
    expect(screen.getByText(/nothing yet/i)).toBeTruthy();
  });
});

describe("ApprovalWidget", () => {
  const approval = (over: Partial<PendingApproval> = {}): PendingApproval => ({ id: "a1", tool: "shell.run", summary: "Run: npm install", tier: "T2", needsPin: false, ...over });

  it("is a dim 'none waiting' frame when nothing is waiting", () => {
    render(<ApprovalWidget approval={null} send={() => {}} />);
    expect(screen.getByText(/none waiting/i)).toBeTruthy();
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("shows what is being asked and sends exactly the messages the old card sent", () => {
    const send = vi.fn();
    render(<ApprovalWidget approval={approval()} send={send} />);
    expect(screen.getByRole("alertdialog", { name: /approval needed/i })).toBeTruthy();
    expect(screen.getByText(/npm install/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /approve$/i }));
    expect(send).toHaveBeenCalledWith({ type: "approval.respond", id: "a1", decision: "approve" });
    fireEvent.click(screen.getByRole("button", { name: /deny/i }));
    expect(send).toHaveBeenCalledWith({ type: "approval.respond", id: "a1", decision: "deny" });
  });

  it("shows the tier of what is being asked, like the old card", () => {
    render(<ApprovalWidget approval={approval({ tier: "T3", needsPin: true })} send={() => {}} />);
    expect(screen.getByText("T3")).toBeTruthy();
  });

  it("offers 'always allow' only for a T2 that needs no PIN", () => {
    const { rerender } = render(<ApprovalWidget approval={approval()} send={() => {}} />);
    expect(screen.getByRole("button", { name: /always allow/i })).toBeTruthy();
    rerender(<ApprovalWidget approval={approval({ tier: "T3", needsPin: true })} send={() => {}} />);
    expect(screen.queryByRole("button", { name: /always allow/i })).toBeNull();
  });

  it("will not approve before the PIN is long enough, and sends the PIN with it", () => {
    const send = vi.fn();
    render(<ApprovalWidget approval={approval({ tier: "T3", needsPin: true })} send={send} />);
    const approve = screen.getByRole("button", { name: /approve$/i }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    for (const d of "123456") fireEvent.click(screen.getByRole("button", { name: d }));
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);
    expect(send).toHaveBeenCalledWith({ type: "approval.respond", id: "a1", decision: "approve", pin: "123456" });
  });
});

describe("TicketsWidget and BudgetWidget", () => {
  it("say honestly that there are no workers yet", () => {
    render(
      <>
        <TicketsWidget />
        <BudgetWidget />
      </>,
    );
    expect(screen.getAllByText(/no workers yet/i)).toHaveLength(2);
  });
});
