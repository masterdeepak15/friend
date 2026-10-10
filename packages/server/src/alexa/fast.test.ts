import { describe, expect, it } from "vitest";
import type { PortfolioSummary } from "../brokers/portfolio";
import type { TaskRow } from "../tasks";
import { portfolioSpeech, statusSpeech, tasksSpeech } from "./fast";

const summary = (over: Partial<PortfolioSummary> = {}): PortfolioSummary => ({ value: 123456.5, invested: 100000, pnl: 23456.5, pnlPct: 23.46, dayChange: 1200, dayChangePct: 0.98, gainers: [], losers: [], topHoldingPct: 30, top: [{ symbol: "INFY", pct: 30 }], ...over });
const task = (id: number, title: string, dueAt: number | null = null): TaskRow => ({ id, title, dueAt, repeat: null });

describe("what is said about the portfolio", () => {
  it("is the value, today's move and the overall profit, in words, with Indian grouping and no rupee sign", () => {
    const out = portfolioSpeech(summary(), "en");
    expect(out).toContain("1,23,456.50 rupees");
    expect(out).toMatch(/up 0\.98 percent today/);
    expect(out).toMatch(/profit of 23,456\.50 rupees/);
    expect(out).not.toContain("₹");
    expect(out).not.toMatch(/buy|sell|should/i);
  });

  it("says down and loss when it is down", () => {
    const out = portfolioSpeech(summary({ dayChange: -500, dayChangePct: -0.4, pnl: -2000, pnlPct: -2 }), "en");
    expect(out).toMatch(/down 0\.4 percent today/);
    expect(out).toMatch(/loss of 2,000 rupees/);
  });

  it("says there is nothing to report for an empty account, and speaks Hindi in Hindi", () => {
    expect(portfolioSpeech(summary({ value: 0, invested: 0, pnl: 0, dayChange: 0 }), "en")).toMatch(/no holdings/i);
    expect(portfolioSpeech(summary(), "hi")).toMatch(/[ऀ-ॿ]/);
  });
});

describe("what is said about tasks", () => {
  it("counts them and names the first few", () => {
    const out = tasksSpeech([task(1, "Buy milk"), task(2, "Call Anu"), task(3, "Pay rent"), task(4, "Book tickets")], "en");
    expect(out).toContain("4 open tasks");
    expect(out).toContain("Buy milk");
    expect(out).toContain("Pay rent");
    expect(out).not.toContain("Book tickets");
  });

  it("handles none and one", () => {
    expect(tasksSpeech([], "en")).toMatch(/no open tasks/i);
    expect(tasksSpeech([task(1, "Buy milk")], "en")).toMatch(/1 open task\b/);
  });
});

describe("what is said about the status", () => {
  it("says Friend is running and what is waiting, without secrets", () => {
    const out = statusSpeech({ openTasks: 2, brokerLoggedIn: false }, "en");
    expect(out).toMatch(/Friend is running/);
    expect(out).toMatch(/2 open tasks/);
    expect(out).toMatch(/Zerodha.*log/i);
    expect(statusSpeech({ openTasks: 0, brokerLoggedIn: null }, "en")).not.toMatch(/Zerodha/);
  });
});
