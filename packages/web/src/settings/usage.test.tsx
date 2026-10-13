import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { UsageTab, type UsageApi, type UsageSummary } from "./UsageTab";

afterEach(cleanup);

const day = (d: string, input = 0, output = 0, turns = 0) => ({ day: d, input, output, turns });
const summary = (over: Partial<UsageSummary> = {}): UsageSummary => ({
  range: 7,
  days: [day("2026-10-12"), day("2026-10-13", 1200, 300, 4), day("2026-10-14", 2_500_000, 40_000, 30)],
  total: { input: 2_501_200, output: 40_300, turns: 34 },
  byModel: [{ provider: "claude-code", model: "sonnet", input: 2_501_200, output: 40_300, turns: 34 }],
  bySource: [{ source: "voice", input: 2_000_000, output: 30_000, turns: 20 }, { source: "chat", input: 501_200, output: 10_300, turns: 14 }],
  ...over,
});
function api(s = summary()): UsageApi {
  return { summary: vi.fn(async (days: number) => ({ ...s, range: days })), clear: vi.fn(async () => ({ removed: 34 })) };
}

describe("the usage page", () => {
  it("shows the totals for the range, with big numbers in short form", async () => {
    render(<UsageTab api={api()} />);
    expect(await screen.findByText("2.5M")).toBeTruthy(); // input
    expect(screen.getByText("40.3K")).toBeTruthy(); // output
    expect(screen.getByText("34")).toBeTruthy(); // turns
  });

  it("lists each day with the exact numbers, newest first", async () => {
    render(<UsageTab api={api()} />);
    const rows = await screen.findAllByRole("row");
    const text = rows.map((r) => r.textContent ?? "");
    const i14 = text.findIndex((t) => t.includes("2026-10-14"));
    const i13 = text.findIndex((t) => t.includes("2026-10-13"));
    expect(i14).toBeGreaterThan(-1);
    expect(i14).toBeLessThan(i13);
    expect(text[i13]).toMatch(/1,200/);
    expect(text[i13]).toMatch(/300/);
  });

  it("splits by model and by where the request came from", async () => {
    render(<UsageTab api={api()} />);
    expect(await screen.findByText(/claude-code \/ sonnet/)).toBeTruthy();
    expect(screen.getByText(/^Voice$/)).toBeTruthy();
    expect(screen.getByText(/^Chat$/)).toBeTruthy();
  });

  it("asks again for a longer range when one is chosen", async () => {
    const a = api();
    render(<UsageTab api={a} />);
    await screen.findByText("34");
    expect(a.summary).toHaveBeenLastCalledWith(7);
    await userEvent.click(screen.getByRole("button", { name: /30 days/i }));
    await waitFor(() => expect(a.summary).toHaveBeenLastCalledWith(30));
  });

  it("says plainly when nothing has been counted yet, and that words are never kept", async () => {
    render(<UsageTab api={api(summary({ days: [day("2026-10-14")], total: { input: 0, output: 0, turns: 0 }, byModel: [], bySource: [] }))} />);
    expect(await screen.findByText(/nothing counted yet/i)).toBeTruthy();
    expect(screen.getByText(/counts only/i)).toBeTruthy();
  });

  it("clears the counts only after being asked twice", async () => {
    const a = api();
    render(<UsageTab api={a} />);
    await userEvent.click(await screen.findByRole("button", { name: /clear saved counts/i }));
    expect(a.clear).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: /yes, clear them/i }));
    await waitFor(() => expect(a.clear).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/removed 34/i)).toBeTruthy();
  });

  it("can back out of clearing", async () => {
    const a = api();
    render(<UsageTab api={a} />);
    await userEvent.click(await screen.findByRole("button", { name: /clear saved counts/i }));
    await userEvent.click(screen.getByRole("button", { name: /^keep them$/i }));
    expect(a.clear).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /clear saved counts/i })).toBeTruthy();
  });

  it("shows why it could not load", async () => {
    const a = api();
    (a.summary as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Could not reach Friend. Check the connection."));
    render(<UsageTab api={a} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not reach friend/i);
  });

  it("marks the busiest day in the bars", async () => {
    render(<UsageTab api={api()} />);
    const bars = await screen.findAllByRole("img", { name: /tokens on/i });
    const label = (el: HTMLElement) => el.getAttribute("aria-label") ?? "";
    expect(bars.some((b) => /2026-10-14/.test(label(b)))).toBe(true);
    const heights = bars.map((b) => parseInt(b.style.height, 10));
    expect(Math.max(...heights)).toBe(100);
    expect(parseInt(bars.find((b) => /2026-10-14/.test(label(b)))!.style.height, 10)).toBe(100);
  });
});
