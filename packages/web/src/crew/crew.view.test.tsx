import { readFileSync } from "node:fs";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, reduce } from "../store";
import { CrewDock } from "./CrewDock";

afterEach(cleanup);

const ada = { id: "ada", name: "Ada", role: "researcher", tools: ["web.*"], status: "working" as const, task: "find the capital of France", since: Date.now() - 5000, lastAt: 0 };
const ben = { id: "ben", name: "Ben", role: "notes", tools: [], status: "idle" as const, task: "", since: null, lastAt: Date.now() - 120_000 };

describe("the crew in the store", () => {
  it("keeps the workers, their live lines and what was read of them, and drops the lines of a worker that is gone", () => {
    let s = reduce(initialState, { type: "crew.state", workers: [ada, ben] } as never);
    s = reduce(s, { type: "crew.feed", workerId: "ada", at: 1, kind: "tool", text: "Searching the web" } as never);
    s = reduce(s, { type: "crew.data", workerId: "ada", what: "history", path: "", text: "Asked: x" } as never);
    expect(s.crew.feed.ada).toEqual([{ at: 1, kind: "tool", text: "Searching the web" }]);
    expect(s.crew.data["ada:history"]?.text).toBe("Asked: x");
    s = reduce(s, { type: "crew.state", workers: [ben] } as never);
    expect(s.crew.feed.ada).toBeUndefined();
  });
});

describe("the crew badge and panel", () => {
  const crew = { workers: [ada, ben], feed: { ada: [{ at: Date.now(), kind: "tool", text: "Searching the web" }, { at: Date.now(), kind: "text", text: "Found it" }] }, data: {} };

  it("shows nothing when there is no crew", () => {
    const { container } = render(<CrewDock crew={{ workers: [], feed: {}, data: {} }} send={vi.fn()} />);
    expect(container.firstChild).toBeNull();
  });

  it("says how many are working, lists them with what each does, and shows the live feed of one", () => {
    render(<CrewDock crew={crew} send={vi.fn()} />);
    fireEvent.click(screen.getByRole("button", { name: /crew · 1 working/i }));
    expect(screen.getByText(/working .*Found it/)).toBeTruthy(); // the newest step, not the whole task
    expect(screen.getByText(/idle · last 2m ago/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Ada/ }));
    expect(screen.getByText("Found it")).toBeTruthy();
  });

  it("asks for a worker's own conversation and wiki only when those tabs are opened, and offers no way to talk to a worker directly", () => {
    const send = vi.fn();
    render(<CrewDock crew={crew} send={send} />);
    fireEvent.click(screen.getByRole("button", { name: /crew/i }));
    fireEvent.click(screen.getByRole("button", { name: /Ada/ }));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: "Talk" }));
    expect(send).toHaveBeenLastCalledWith({ type: "crew.view", workerId: "ada", what: "history" });
    fireEvent.click(screen.getByRole("tab", { name: "Memory" }));
    expect(send).toHaveBeenLastCalledWith({ type: "crew.view", workerId: "ada", what: "memory" });
    fireEvent.click(screen.getByRole("tab", { name: "Tools" }));
    expect(screen.getByText("web.*")).toBeTruthy();
    expect(screen.queryByRole("textbox", { name: /say to/i })).toBeNull();
  });
});

describe("the badge can be clicked", () => {
  it("takes the pointer back from the overlay layer, which ignores it", () => {
    const css = readFileSync(new URL("./crew.css", import.meta.url), "utf8");
    expect(css).toMatch(/.cr-badge, .cr-panel { pointer-events: auto;/);
  });
});
