import type { PendingApproval } from "@friend/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApprovalWidget } from "./ApprovalWidget";
import { BudgetWidget } from "./BudgetWidget";
import { FeedWidget } from "./FeedWidget";
import { TicketsWidget } from "./TicketsWidget";
import { VoiceWidget } from "./VoiceWidget";

afterEach(cleanup);

const levels = (c: HTMLElement) => [...c.querySelectorAll("rect.ob-eq")].map((r) => Number((r as unknown as HTMLElement).style.getPropertyValue("--lv")));

describe("VoiceWidget", () => {
  it("draws 20 bars that stay small but alive when there is no sound", () => {
    const { container } = render(<VoiceWidget level={0} mode="idle" />);
    const l = levels(container);
    expect(l).toHaveLength(20);
    expect(Math.max(...l)).toBeLessThanOrEqual(0.5);
    expect(Math.min(...l)).toBeGreaterThanOrEqual(0.15);
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

  it("never offers 'always allow' for a worker's question", () => {
    render(<ApprovalWidget approval={approval({ tool: "office.action" })} send={() => {}} />);
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

describe("TicketsWidget", () => {
  it("always shows the title with its project and the legend, with zeros until there are workers", () => {
    const { container } = render(<TicketsWidget />);
    expect(container.textContent).toMatch(/TICKETS · no workers yet/i);
    expect(container.textContent).toMatch(/DONE 0.*DOING 0.*REVIEW 0.*TODO 0/);
  });

  it("names the project when it has one, and counts each status", () => {
    const cells = [{ status: "done" as const }, { status: "done" as const }, { status: "doing" as const }];
    const { container } = render(<TicketsWidget project="landing-page" cells={cells} />);
    expect(container.textContent).toMatch(/TICKETS · landing-page/);
    expect(container.textContent).toMatch(/DONE 2.*DOING 1.*REVIEW 0.*TODO 0/);
  });
});

describe("FeedWidget scrolling", () => {
  const lines = Array.from({ length: 5 }, (_, i) => ({ text: `step ${i}`, tone: "plain" as const }));

  it("loops a sample feed upward, each line twice so the loop has no gap", () => {
    const { container } = render(<FeedWidget lines={lines} activity={null} busy={false} marquee />);
    const g = container.querySelector(".ob-feed-scroll")!;
    expect(g).toBeTruthy();
    expect(g.querySelectorAll("text")).toHaveLength(10);
    expect((g as unknown as HTMLElement).style.getPropertyValue("--n")).toBe("100");
    expect(container.querySelector("rect.ob-feed-fade")).toBeTruthy();
  });

  it("slides a real feed up by one line when a new line arrives", () => {
    const { container, rerender } = render(<FeedWidget lines={lines.slice(0, 2)} activity={null} busy={false} />);
    const before = container.querySelector(".ob-feed-in")!;
    expect(before).toBeTruthy();
    rerender(<FeedWidget lines={lines.slice(0, 3)} activity={null} busy={false} />);
    expect(container.querySelector(".ob-feed-in")).not.toBe(before); // a new group, so its slide runs again
  });

  it("has the keyframes for both", () => {
    const css = readFileSync(join(process.cwd(), "src/hud/orbital/orbital.css"), "utf8");
    expect(css).toMatch(/@keyframes ob-feed-scroll/);
    expect(css).toMatch(/@keyframes ob-feed-in/);
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
