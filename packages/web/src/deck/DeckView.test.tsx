import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { DeckView as View } from "@friend/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DeckView } from "./DeckView";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const item = (id: string, text: string, extra: object = {}) => ({ id, kind: "text", content: { text }, say: `say ${id}`, ...extra });
const view = (over: Partial<View> = {}): View => ({
  deckId: "d_1",
  title: "Hacking",
  index: 2,
  total: 12,
  slide: { id: "s3", title: "Reconnaissance", layout: "bullets", items: [item("a", "Scan the network", { animation: "slide-left" }), item("b", "Read the banners"), item("c", "Map the services", { animation: "grow" })] },
  shown: 2,
  state: "playing",
  ...over,
});

describe("a presentation on the screen", () => {
  it("shows the slide title, the counter and only the items that were revealed", () => {
    render(<DeckView view={view()} onControl={() => {}} />);
    expect(screen.getByRole("heading", { name: "Reconnaissance" })).toBeTruthy();
    expect(screen.getByText("3 / 12")).toBeTruthy();
    expect(screen.getByText("Scan the network")).toBeTruthy();
    expect(screen.getByText("Read the banners")).toBeTruthy();
    expect(screen.queryByText("Map the services")).toBeNull();
  });

  it("gives the newest item its animation, and an item that was already there is not animated again", () => {
    const { rerender, container } = render(<DeckView view={view({ shown: 2 })} onControl={() => {}} />);
    rerender(<DeckView view={view({ shown: 3 })} onControl={() => {}} />);
    const grown = container.querySelector('[data-item="c"]')!;
    expect(grown.className).toMatch(/anim-grow/);
    // the item that came on before was on the screen when it first drew: no animation of its own
    expect(container.querySelector('[data-item="a"]')!.className).not.toMatch(/anim-/);
  });

  it("plays no animation for someone who asked for less motion", () => {
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("reduce"), media: q, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} }));
    const { rerender, container } = render(<DeckView view={view({ shown: 1 })} onControl={() => {}} />);
    rerender(<DeckView view={view({ shown: 3 })} onControl={() => {}} />);
    expect(container.querySelector('[class*="anim-"]')).toBeNull();
  });

  it("says when it is paused, and the buttons steer it", async () => {
    const control = vi.fn();
    const { rerender } = render(<DeckView view={view()} onControl={control} />);
    await userEvent.click(screen.getByRole("button", { name: "Pause" }));
    await userEvent.click(screen.getByRole("button", { name: "Next slide" }));
    await userEvent.click(screen.getByRole("button", { name: "Previous slide" }));
    await userEvent.click(screen.getByRole("button", { name: "Stop presentation" }));
    expect(control.mock.calls.map((c) => c[0])).toEqual(["pause", "next", "back", "stop"]);
    rerender(<DeckView view={view({ state: "paused" })} onControl={control} />);
    expect(screen.getByText(/Paused/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(control).toHaveBeenLastCalledWith("resume");
  });

  it("draws a Jarvis table item with the same drawing the stage uses, given the plain list rows", async () => {
    const v = view({ shown: 2, slide: { id: "s", title: "Numbers", layout: "visual", items: [{ id: "t", kind: "JTable", content: { columns: ["Tool", "Use"], rows: [["nmap", "scan"]] }, say: "x" }] } });
    render(<DeckView view={{ ...v, shown: 1 }} onControl={() => {}} />);
    expect(await screen.findByText("nmap")).toBeTruthy();
    expect(await screen.findByText("scan")).toBeTruthy();
  });

  it("says it has ended", () => {
    render(<DeckView view={view({ state: "ended", shown: 3 })} onControl={() => {}} />);
    expect(screen.getByText(/The end|Finished/)).toBeTruthy();
  });
});
