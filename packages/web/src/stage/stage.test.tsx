import type { ClientMsg, StageObject } from "@friend/protocol";
import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { initialState, type StageViewState } from "../store";
import { placementToStyle } from "./placement";
import { sanitizeMarkdown } from "./sanitize";
import { Stage } from "./Stage";

const obj = (id: string, type: StageObject["type"], props: Record<string, unknown>): StageObject => ({
  id,
  type,
  props,
  placement: "center",
});
const withState = (patch: Partial<StageViewState>): StageViewState => ({ ...initialState, connection: "open", ...patch });

describe("sanitizeMarkdown", () => {
  it("removes event handler attributes and raw images", () => {
    const html = sanitizeMarkdown("<img src=x onerror=alert(1)>hi");
    expect(html).not.toMatch(/onerror/i);
    expect(html).not.toMatch(/<img/i);
    expect(html).toContain("hi");
  });
  it("removes script tags", () => {
    expect(sanitizeMarkdown("a<script>alert(1)</script>b")).not.toMatch(/<script/i);
  });
  it("neutralizes javascript: links", () => {
    expect(sanitizeMarkdown("[x](javascript:alert(1))")).not.toMatch(/javascript:/i);
  });
  it("renders basic markdown and opens links safely", () => {
    const html = sanitizeMarkdown("**bold** and [site](https://example.com)");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toMatch(/rel="noopener noreferrer"/);
  });
});

describe("placementToStyle", () => {
  const desktop = { w: 1280, h: 800 };
  it("maps relative boxes to percentages and absolute positioning", () => {
    const s = placementToStyle({ x: 0.1, y: 0.2, w: 0.3, h: 0.4 }, desktop);
    expect(s).toMatchObject({ position: "absolute", left: "10%", top: "20%", width: "30%", height: "40%" });
  });
  it("maps named regions to percentage boxes", () => {
    const s = placementToStyle("left", desktop);
    expect(s.position).toBe("absolute");
    expect(String(s.left)).toMatch(/%$/);
  });
  it("sizes top and bottom regions to their content (max height) and tall regions with a fixed height", () => {
    const bottom = placementToStyle("bottom", desktop);
    expect(bottom.height).toBeUndefined();
    expect(String(bottom.maxHeight)).toMatch(/%$/);
    const left = placementToStyle("left", desktop);
    expect(String(left.height)).toMatch(/%$/);
  });
  it("leaves auto placement to the grid in normal flow", () => {
    expect(placementToStyle("auto", desktop)).toEqual({ position: "relative" });
  });
  it("stacks objects in normal flow on narrow screens", () => {
    expect(placementToStyle("center", { w: 390, h: 844 }).position).toBe("relative");
    expect(placementToStyle({ x: 0, y: 0, w: 0.5, h: 0.5 }, { w: 390, h: 844 }).position).toBe("relative");
  });
});

describe("<Stage>", () => {
  const noop = () => {};

  it("shows the presence full-screen in conversation and in the corner in focus", () => {
    const { container, rerender } = render(<Stage state={withState({ scene: "conversation" })} send={noop} dispatch={noop} />);
    expect((container.querySelector("[data-presence]") as HTMLElement).dataset.mode).toBe("full");
    rerender(<Stage state={withState({ scene: "focus" })} send={noop} dispatch={noop} />);
    expect((container.querySelector("[data-presence]") as HTMLElement).dataset.mode).toBe("corner");
  });

  it("renders captions", () => {
    render(<Stage state={withState({ captions: "Good evening, boss." })} send={noop} dispatch={noop} />);
    expect(screen.getByText("Good evening, boss.")).toBeTruthy();
  });

  it("renders card, stat, list, table and code objects from props", () => {
    const objects = [
      obj("c", "card", { title: "Note", text: "hello **world**" }),
      obj("s", "stat", { label: "CPU", value: 42, unit: "%" }),
      obj("l", "list", { title: "Todo", items: ["one", { text: "two", done: true }] }),
      obj("t", "table", { columns: ["Name", "Size"], rows: [["a.txt", 12]] }),
      obj("k", "code", { language: "ts", code: "const x = 1;" }),
    ];
    const { container } = render(<Stage state={withState({ scene: "multi", objects })} send={noop} dispatch={noop} />);
    expect(container.querySelector("strong")?.textContent).toBe("world");
    expect(screen.getByText("CPU")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("two")).toBeTruthy();
    expect(screen.getByText("a.txt")).toBeTruthy();
    expect(container.querySelector("pre code")?.textContent).toBe("const x = 1;");
  });

  it("renders nothing for an unknown object type and does not throw", () => {
    const bogus = { ...obj("x", "card", {}), type: "bogus" } as unknown as StageObject;
    expect(() => render(<Stage state={withState({ objects: [bogus] })} send={noop} dispatch={noop} />)).not.toThrow();
  });

  it("survives malformed props", () => {
    const objects = [obj("a", "table", { columns: 5, rows: "no" }), obj("b", "list", { items: { a: 1 } }), obj("c", "stat", {})];
    expect(() => render(<Stage state={withState({ objects })} send={noop} dispatch={noop} />)).not.toThrow();
  });

  it("dismissing an object tells the server and removes it locally", async () => {
    const send = vi.fn<(m: ClientMsg) => void>();
    const dispatch = vi.fn();
    render(<Stage state={withState({ objects: [obj("note", "card", { text: "hi" })] })} send={send} dispatch={dispatch} />);
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(send).toHaveBeenCalledWith({ type: "stage.event", objectId: "note", event: "dismiss" });
    expect(dispatch).toHaveBeenCalledWith({ type: "object.dismiss", id: "note" });
  });
});

describe("auto layout, exit animation and mood", () => {
  const noop = () => {};

  it("places auto objects in the grid and keeps explicit placements absolute", () => {
    const objects = [obj("g1", "card", { text: "one" }), obj("g2", "card", { text: "two" })].map((x) => ({ ...x, placement: "auto" as const }));
    const fixed = obj("f", "card", { text: "fixed" });
    const { container } = render(<Stage state={withState({ scene: "multi", objects: [...objects, fixed] })} send={noop} dispatch={noop} />);
    const grid = container.querySelector(".auto-grid")!;
    expect(grid.querySelectorAll("section.obj")).toHaveLength(2);
    expect(grid.textContent).not.toContain("fixed");
    expect((screen.getByText("fixed").closest("section") as HTMLElement).style.position).toBe("absolute");
  });

  it("renders no grid when nothing uses auto placement", () => {
    const { container } = render(<Stage state={withState({ objects: [obj("f", "card", { text: "x" })] })} send={noop} dispatch={noop} />);
    expect(container.querySelector(".auto-grid")).toBeNull();
  });

  it("fades a removed object out before dropping it", () => {
    vi.useFakeTimers();
    const a = { ...obj("a", "card", { text: "bye" }), placement: "auto" as const };
    const { container, rerender } = render(<Stage state={withState({ objects: [a] })} send={noop} dispatch={noop} />);
    rerender(<Stage state={withState({ objects: [] })} send={noop} dispatch={noop} />);
    expect(container.querySelector("section.obj.leaving")).toBeTruthy();
    act(() => void vi.advanceTimersByTime(400));
    expect(container.querySelector("section.obj")).toBeNull();
    vi.useRealTimers();
  });

  it("uses mood intensity for the ambient glow", () => {
    const { container } = render(
      <Stage state={withState({ mood: { accent: "#ffb454", intensity: 0.2 } })} send={noop} dispatch={noop} />,
    );
    const root = screen.getByTestId("stage");
    expect(root.style.getPropertyValue("--intensity")).toBe("0.2");
    expect(root.style.getPropertyValue("--accent")).toBe("#ffb454");
    expect(Number((container.querySelector(".ambient") as HTMLElement).style.opacity)).toBeCloseTo(0.35 + 0.65 * 0.2, 2);
  });
});

describe("<CommandBar> inside the stage", () => {
  it("opens on a key press, sends chat.send on Enter, and hides again", async () => {
    const send = vi.fn<(m: ClientMsg) => void>();
    render(<Stage state={withState({})} send={send} dispatch={() => {}} />);
    expect(screen.queryByLabelText(/message/i)).toBeNull();
    fireEvent.keyDown(window, { key: "h" }); // the first key is kept: the bar opens pre-filled with "h"
    const input = (await screen.findByLabelText(/message/i)) as HTMLInputElement;
    expect(input.value).toBe("h");
    await userEvent.type(input, "ello there{Enter}");
    expect(send).toHaveBeenCalledWith({ type: "chat.send", text: "hello there" });
    expect(screen.queryByLabelText(/message/i)).toBeNull();
  });
  it("does not send an empty message", async () => {
    const send = vi.fn();
    render(<Stage state={withState({})} send={send} dispatch={() => {}} />);
    await userEvent.click(screen.getByTestId("stage"));
    const input = await screen.findByLabelText(/message/i);
    await userEvent.type(input, "   {Enter}");
    expect(send).not.toHaveBeenCalled();
  });
  it("opens when the empty stage is tapped", async () => {
    render(<Stage state={withState({})} send={() => {}} dispatch={() => {}} />);
    await userEvent.click(screen.getByTestId("stage"));
    expect(await screen.findByLabelText(/message/i)).toBeTruthy();
  });
});
