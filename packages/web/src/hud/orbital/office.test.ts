import type { OfficeTicketView, OfficeWorkerView } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { ORG_CARD_H, ORG_CARD_W, ORG_GAP_X, ORG_GAP_Y, budgetRings, feedLines, layoutOrg, ticketCells, ticketProject, usageFromQuota, workerNodes } from "./office";

const worker = (name: string, over: Partial<OfficeWorkerView> = {}): OfficeWorkerView => ({ id: name.toLowerCase(), name, roleId: "scribe", title: "Scribe", capabilities: "", managerId: null, projectId: "site", status: "idle", ticketId: null, detail: "", tokens: 0, budget: null, startedAt: null, ...over });
const ticket = (id: number, status: OfficeTicketView["status"], projectId = "site"): OfficeTicketView => ({ id, projectId, title: `T${id}`, status, workerId: null });

describe("workerNodes", () => {
  it("maps each status to what the orbit can show", () => {
    const status = (s: OfficeWorkerView["status"]) => workerNodes([worker("Ada", { status: s })], true)[0]!.status;
    expect(status("running")).toBe("running");
    expect(status("starting")).toBe("running");
    expect(status("waiting")).toBe("waiting");
    for (const s of ["idle", "stopped", "paused", "failed"] as const) expect(status(s)).toBe("idle");
  });

  it("writes the first 6 characters in the hexagon and the whole name under it", () => {
    const n = workerNodes([worker("Scribe Two")], true)[0]!;
    expect(n).toMatchObject({ id: "scribe two", label: "Scribe Two", glyph: "SCRIBE", caption: "Scribe Two", kind: "worker" });
  });

  it("says what a worker is doing, or why it is not", () => {
    expect(workerNodes([worker("Ada", { status: "running", detail: "Write a.txt" })], true)[0]!.detail).toBe("Write a.txt");
    expect(workerNodes([worker("Ada", { status: "paused" })], true)[0]!.detail).toBe("paused");
    expect(workerNodes([worker("Ada", { status: "failed", detail: "claude is not installed" })], true)[0]!.detail).toBe("claude is not installed");
  });

  it("ends with a hire node while the office is on and fewer than five are hired", () => {
    const four = ["A1", "A2", "A3", "A4"].map((n) => worker(n));
    expect(workerNodes(four, true).at(-1)).toMatchObject({ kind: "hire", glyph: "+", caption: "HIRE WORKER", status: "add" });
    expect(workerNodes([...four, worker("A5")], true).some((n) => n.kind === "hire")).toBe(false);
    expect(workerNodes(four, false).some((n) => n.kind === "hire")).toBe(false);
    expect(workerNodes([], true)).toHaveLength(1);
  });

  it("shows at most five workers", () => {
    expect(workerNodes(Array.from({ length: 8 }, (_, i) => worker(`W${i}`)), true)).toHaveLength(5);
  });
});

describe("ticketCells", () => {
  it("counts blocked as review, and keeps the newest 11 in the order done, doing, review, todo", () => {
    const all = [ticket(1, "todo"), ticket(2, "blocked"), ticket(3, "done"), ticket(4, "doing")];
    expect(ticketCells(all).map((c) => c.status)).toEqual(["done", "doing", "review", "todo"]);
    const many = Array.from({ length: 15 }, (_, i) => ticket(i + 1, "todo"));
    expect(ticketCells(many)).toHaveLength(11);
    const old = [ticket(1, "done"), ...Array.from({ length: 11 }, (_, i) => ticket(i + 2, "todo"))];
    expect(ticketCells(old).some((c) => c.status === "done")).toBe(false);
  });
});

describe("ticketProject", () => {
  it("names the project, or counts several, or says nothing", () => {
    expect(ticketProject([ticket(1, "todo", "site"), ticket(2, "done", "site")])).toBe("site");
    expect(ticketProject([ticket(1, "todo", "site"), ticket(2, "done", "app")])).toBe("2 projects");
    expect(ticketProject([])).toBeUndefined();
  });
});

describe("budgetRings", () => {
  it("shows the share of the limit used, up to three workers that have one", () => {
    const ws = [worker("Ada", { tokens: 250, budget: 1000 }), worker("Bob", { tokens: 5, budget: 0 }), worker("Cy", { tokens: 5000, budget: 1000 }), worker("Di", { tokens: 10, budget: null }), worker("Ed", { tokens: 1, budget: 10 }), worker("Flo", { tokens: 2, budget: 10 })];
    expect(budgetRings(ws)).toEqual([
      { label: "ADA", value: 25, text: "25%" },
      { label: "CY", value: 100, text: "100%" },
      { label: "ED", value: 10, text: "10%" },
    ]);
  });

  it("with no limits set, shows what each worker has used against the busiest one, so the instrument is not empty", () => {
    const ws = [worker("Ada", { tokens: 1100 }), worker("Bob", { tokens: 4400 }), worker("Cy", { tokens: 0 }), worker("Di", { tokens: 50 })];
    expect(budgetRings(ws)).toEqual([
      { label: "BOB", value: 100, text: "4.4K" },
      { label: "ADA", value: 25, text: "1.1K" },
      { label: "DI", value: 1, text: "50" },
    ]);
    expect(budgetRings([worker("Ada")])).toEqual([{ label: "ADA", value: 0, text: "0" }]);
    expect(budgetRings([])).toEqual([]);
  });
});

describe("feedLines", () => {
  it("merges the newest lines of every worker, oldest first, with the worker's name and a tone", () => {
    const ws = [worker("Ada"), worker("Bob")];
    const feed = {
      ada: [
        { at: 1, kind: "tool", text: "Write a.txt" },
        { at: 4, kind: "text", text: "Done." },
      ],
      bob: [
        { at: 2, kind: "approval", text: "wants: npm install" },
        { at: 3, kind: "result", text: "12 passed" },
        { at: 5, kind: "error", text: "boom" },
      ],
    };
    const lines = feedLines(feed, ws, 4);
    expect(lines.map((l) => l.text)).toEqual(["BOB    wants: npm install", "BOB    12 passed", "ADA    Done.", "BOB    boom"]);
    expect(lines.map((l) => l.tone)).toEqual(["orange", "green", "plain", "orange"]);
  });

  it("is empty with no feed, and skips a worker that is gone", () => {
    expect(feedLines({}, [worker("Ada")])).toEqual([]);
    expect(feedLines({ ghost: [{ at: 1, kind: "text", text: "x" }] }, [worker("Ada")])).toEqual([]);
  });
});

describe("usageFromQuota", () => {
  const now = Date.UTC(2026, 9, 20, 12, 0, 0);
  const resets = (ms: number) => Math.floor((now + ms) / 1000);
  const quota = (utilization: number, ms: number) => ({ fiveHour: { utilization, resetsAt: resets(ms) }, sevenDay: null });

  it("uses the five-hour window and says when it resets", () => {
    expect(usageFromQuota(quota(0.42, (2 * 60 + 10) * 60_000), 17, now)).toEqual({ value: 42, reset: "2H 10M", real: true });
    expect(usageFromQuota(quota(0.9, 45 * 60_000), 17, now)).toEqual({ value: 90, reset: "45M", real: true });
  });

  it("falls back to today against the busiest day when there is no window, or it has already reset", () => {
    expect(usageFromQuota({ fiveHour: null, sevenDay: null }, 17, now)).toEqual({ value: 17, reset: null, real: false });
    expect(usageFromQuota(quota(0.42, -60_000), 17, now)).toEqual({ value: 17, reset: null, real: false });
    expect(usageFromQuota({ fiveHour: null, sevenDay: null }, null, now)).toEqual({ value: null, reset: null, real: false });
  });
});

describe("layoutOrg, the tree of who reports to whom", () => {
  const w = (name: string, managerId: string | null = null) => worker(name, { managerId });
  const at = (l: ReturnType<typeof layoutOrg>, id: string) => l.nodes.find((n) => n.id === id)!;

  it("puts Friend at the top and the workers who report to Friend one level down, side by side", () => {
    const l = layoutOrg([w("Ada"), w("Bob")]);
    expect(at(l, "friend").y).toBe(0);
    expect(at(l, "ada").y).toBe(ORG_CARD_H + ORG_GAP_Y);
    expect(at(l, "bob").y).toBe(ORG_CARD_H + ORG_GAP_Y);
    expect(at(l, "bob").x - at(l, "ada").x).toBe(ORG_CARD_W + ORG_GAP_X);
    expect(at(l, "friend").x).toBe((at(l, "ada").x + at(l, "bob").x) / 2); // the parent is centred over its reports
    expect(l.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["friend>ada", "friend>bob"]);
  });

  it("follows the reporting lines down several levels", () => {
    const l = layoutOrg([w("Lena"), w("Ben", "lena"), w("Cy", "ben")]);
    expect([at(l, "friend").y, at(l, "lena").y, at(l, "ben").y, at(l, "cy").y]).toEqual([0, 1, 2, 3].map((n) => n * (ORG_CARD_H + ORG_GAP_Y)));
    expect(l.edges.map((e) => `${e.from}>${e.to}`).sort()).toEqual(["ben>cy", "friend>lena", "lena>ben"]);
  });

  it("does not let a subtree sit on its neighbour", () => {
    const l = layoutOrg([w("Lena"), w("Ben", "lena"), w("Cy", "lena"), w("Di", "lena"), w("Ed")]);
    const xs = (ids: string[]) => ids.map((i) => at(l, i).x);
    const [ben, cy, di, ed] = xs(["ben", "cy", "di", "ed"]);
    expect(cy! - ben!).toBeGreaterThanOrEqual(ORG_CARD_W + ORG_GAP_X);
    expect(ed! - di!).toBeGreaterThanOrEqual(ORG_CARD_W + ORG_GAP_X);
    expect(l.width).toBeGreaterThan(0);
    expect(l.height).toBe(3 * (ORG_CARD_H + ORG_GAP_Y) - ORG_GAP_Y);
  });

  it("hangs a worker whose manager is gone, or that is part of a loop, from Friend instead of losing it", () => {
    const l = layoutOrg([w("Ada", "ghost"), w("Bob", "cy"), w("Cy", "bob")]);
    expect(l.nodes.map((n) => n.id).sort()).toEqual(["ada", "bob", "cy", "friend"]);
    expect(l.edges.filter((e) => e.from === "friend").map((e) => e.to)).toContain("ada");
    expect(l.edges).toHaveLength(3);
  });

  it("is just Friend with nobody hired", () => {
    const l = layoutOrg([]);
    expect(l.nodes.map((n) => n.id)).toEqual(["friend"]);
    expect(l.edges).toEqual([]);
  });
});