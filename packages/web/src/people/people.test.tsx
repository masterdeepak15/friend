import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
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
    expect(feed.p.showTime).toBe(true);
    expect(feed.p.items.map((i) => [i.source, i.message, i.level])).toEqual([
      ["⬡ BEN · OFFICE", "Write a.txt", "active"],
      ["▣ ADA · CREW", "Found it", "success"],
    ]);
  });
});
