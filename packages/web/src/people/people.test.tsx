import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { BudgetBoard, TicketBoard } from "../hud/orbital/OfficeViews";
import { feedTree } from "../hud/orbital/jtrees";
import { teamLines } from "../hud/orbital/office";
import { ActivityList } from "./ActivityList";
import { colourOf, hueOf, initials, type Act, type Who } from "./people";

afterEach(cleanup);

const ada: Who = { id: "ada", name: "Ada Lovelace", kind: "crew", role: "researcher" };
const ben: Who = { id: "ben", name: "Ben", kind: "office", role: "builder" };
const act = (who: Who, at: number, kind: string, text: string): Act => ({ who, at, kind, text });

describe("who a message belongs to", () => {
  it("gives each person the same colour every time, and different people different ones", () => {
    expect(hueOf("ada")).toBe(hueOf("ada"));
    expect(colourOf(ada)).toBe(colourOf({ ...ada }));
    expect(colourOf(ada)).not.toBe(colourOf(ben));
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("Ben")).toBe("BE");
  });

  it("puts a run of one person's lines under one name, with a key of who is who", () => {
    render(<ActivityList items={[act(ada, 1000, "task", "find x"), act(ada, 2000, "tool", "Searching"), act(ben, 3000, "text", "Building"), act(ada, 4000, "done", "Found it")]} live={["ben"]} />);
    expect(screen.getAllByRole("region")).toHaveLength(3); // Ada, Ben, Ada again
    expect(screen.getByRole("list", { name: "Who is who" }).textContent).toContain("Ada Lovelace");
    expect(screen.getByRole("list", { name: "Who is who" }).textContent).toContain("CREW");
    expect(screen.getByRole("list", { name: "Who is who" }).textContent).toContain("OFFICE");
    const blocks = screen.getAllByRole("region");
    expect(blocks[0]!.textContent).toContain("Searching");
    expect(blocks[1]!.textContent).toContain("Ben");
    expect(blocks[1]!.querySelector(".ac-av")!.getAttribute("data-live")).toBe("false"); // Ben is not the newest block
  });

  it("does not repeat the key when there is one person", () => {
    render(<ActivityList items={[act(ada, 1000, "text", "hi")]} />);
    expect(screen.queryByRole("list", { name: "Who is who" })).toBeNull();
  });
});

describe("the team feed", () => {
  it("merges the Office and the crew by time, each line knowing whose it is", () => {
    const office = { enabled: true, workers: [{ id: "ben", name: "Ben", title: "builder" }] as never, feed: { ben: [{ at: 2, kind: "tool", text: "Write a.txt" }] } };
    const crew = { workers: [{ id: "ada", name: "Ada", role: "researcher" }] as never, feed: { ada: [{ at: 1, kind: "tool", text: "Searching" }, { at: 3, kind: "done", text: "Found it" }] } };
    const lines = teamLines(office, crew, 8);
    expect(lines.map((l) => `${l.who!.kind}:${l.who!.name}:${l.body}`)).toEqual(["crew:Ada:Searching", "office:Ben:Write a.txt", "crew:Ada:Found it"]);
    expect(teamLines({ ...office, enabled: false }, crew).map((l) => l.who!.kind)).toEqual(["crew", "crew"]); // the Office is off: only the crew
  });
});

describe("the Activity instrument drawn with the Jarvis feed", () => {
  it("puts each line under its person, with the kind and the time", () => {
    const lines = teamLines(
      { enabled: true, workers: [{ id: "ben", name: "Ben", title: "builder" }] as never, feed: { ben: [{ at: 2000, kind: "tool", text: "Write a.txt" }] } },
      { workers: [{ id: "ada", name: "Ada", role: "researcher" }] as never, feed: { ada: [{ at: 3000, kind: "done", text: "Found it" }] } },
    );
    const feed = feedTree(lines, null, false).kids![0] as unknown as { p: { items: { message: string; source?: string; level: string; time?: string }[]; showSource: boolean; showTime: boolean } };
    expect(feed.p.showSource).toBe(true);
    expect(feed.p.showTime).toBe(false); // the small instrument has no room for a time column; the opened one shows it
    expect(feed.p.items.map((i) => [i.source, i.message, i.level])).toEqual([
      ["⬡ BEN", "Write a.txt", "active"],
      ["▣ ADA", "Found it", "success"],
    ]);
  });
});

const office = (over: Record<string, unknown> = {}) => ({
  enabled: true,
  workers: [
    { id: "ben", name: "Ben", title: "builder", status: "running", tokens: 2500, budget: 5000, context: { tokens: 70000, window: 200000 } },
    { id: "kai", name: "Kai", title: "tester", status: "idle", tokens: 900, budget: null, context: null },
  ],
  tickets: [
    { id: 1, projectId: "site", title: "Fix login", status: "doing", workerId: "ben" },
    { id: 2, projectId: "site", title: "Write tests", status: "review", workerId: "kai" },
    { id: 3, projectId: "api", title: "Add route", status: "todo", workerId: null },
    { id: 4, projectId: "api", title: "Old thing", status: "done", workerId: "ben" },
  ],
  quota: { fiveHour: null, sevenDay: null },
  feed: {},
  ...over,
});

describe("the tickets view", () => {
  it("puts each ticket on a card in its column, with its project and whose it is", () => {
    render(<TicketBoard office={office() as never} />);
    const col = (name: string) => screen.getByRole("region", { name });
    expect(col("Being worked on").textContent).toContain("Fix login");
    expect(col("Being worked on").textContent).toContain("Ben");
    expect(col("Needs a look").textContent).toContain("Write tests");
    expect(col("Not started").textContent).toContain("nobody yet");
    expect(col("Done").textContent).toContain("Old thing");
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("1"); // one of four done
  });

  it("says so when the Office is off", () => {
    render(<TicketBoard office={office({ enabled: false }) as never} />);
    expect(screen.getByText(/switched off/)).toBeTruthy();
  });
});

describe("the budget view", () => {
  it("shows each worker's tokens against its limit, or against the busiest worker when it has none", () => {
    render(<BudgetBoard office={office() as never} />);
    expect(screen.getByText(/3.4K/)).toBeTruthy(); // the total
    expect(screen.getByRole("progressbar", { name: "Ben budget" }).getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByText(/50% of its limit · session 35% full/)).toBeTruthy();
    expect(screen.getByRole("progressbar", { name: "Kai budget" }).getAttribute("aria-valuenow")).toBe("36"); // 900 of the busiest 2500
    expect(screen.getByText(/no limit set/)).toBeTruthy();
  });

  it("says so with no workers", () => {
    render(<BudgetBoard office={office({ workers: [] }) as never} />);
    expect(screen.getByText(/No workers yet/)).toBeTruthy();
  });
});
