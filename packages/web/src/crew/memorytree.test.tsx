import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryTreeView, parseOutline, type Outline } from "./MemoryTreeView";

afterEach(cleanup);

const outline: Outline[] = [
  { path: "customers/", kind: "folder", title: "Customers", summary: "who writes to support", depth: 0 },
  { path: "customers/acme.md", kind: "note", title: "Acme", summary: "wants invoices on the 5th", depth: 1 },
  { path: "inbox/", kind: "folder", title: "Inbox", summary: "", depth: 0 },
  { path: "inbox/quick.md", kind: "note", title: "Quick note", summary: "", depth: 1 },
];

describe("a worker's wiki as a tree", () => {
  it("shows folders and notes with their summaries, folds a folder, and opens a note on a click", () => {
    const onOpen = vi.fn();
    render(<MemoryTreeView outline={outline} open="" onOpen={onOpen} />);
    expect(screen.getByRole("tree", { name: "Memory" })).toBeTruthy();
    expect(screen.getByText("Acme")).toBeTruthy();
    expect(screen.getByText(/wants invoices on the 5th/)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Acme/ }));
    expect(onOpen).toHaveBeenCalledWith("customers/acme.md");
    fireEvent.click(screen.getByRole("button", { name: /Customers/ })); // fold it
    expect(screen.queryByText("Acme")).toBeNull();
    expect(screen.getByText("Quick note")).toBeTruthy(); // the other folder is untouched
    expect(onOpen).toHaveBeenCalledTimes(1); // a folder only folds
  });

  it("says so when there are no notes yet, and reads the outline the server sends", () => {
    render(<MemoryTreeView outline={[]} open="" onOpen={vi.fn()} />);
    expect(screen.getByText(/No notes yet/)).toBeTruthy();
    expect(parseOutline(JSON.stringify(outline))).toHaveLength(4);
    expect(parseOutline("not json")).toBeNull();
    expect(parseOutline(undefined)).toBeNull();
  });
});
