import type { ClientMsg } from "@friend/protocol";
import { act, cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyScreen, useScreenReport } from "../layout/screen";
import { ProfileBadge, SPEAKER_MS } from "../overlay/ProfileBadge";
import { initialState, reduce, type StageViewState } from "../store";
import { fit } from "./drag";
import { Stage } from "./Stage";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const card = (id: string, extra: object = {}) => ({ id, type: "card" as const, props: { text: id }, placement: "center" as const, ...extra });
const stageWith = (objects: unknown[]): StageViewState => ({ ...initialState, connection: "open", objects: objects as StageViewState["objects"] });

describe("the store and widgets", () => {
  it("a clear keeps the pinned ones", () => {
    let s = reduce(initialState, { type: "stage", command: { cmd: "show", object: card("clock", { pinned: true }) } });
    s = reduce(s, { type: "stage", command: { cmd: "show", object: card("answer") } });
    s = reduce(s, { type: "stage", command: { cmd: "clear" } });
    expect(s.objects.map((o) => o.id)).toEqual(["clock"]);
  });

  it("pin, unpin and place change only that object", () => {
    let s = reduce(initialState, { type: "stage", command: { cmd: "show", object: card("a") } });
    s = reduce(s, { type: "stage", command: { cmd: "show", object: card("b") } });
    s = reduce(s, { type: "stage", command: { cmd: "pin", id: "a" } });
    expect(s.objects.map((o) => !!o.pinned)).toEqual([true, false]);
    s = reduce(s, { type: "stage", command: { cmd: "place", id: "b", placement: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 } } });
    expect(s.objects[1]!.placement).toEqual({ x: 0.1, y: 0.2, w: 0.3, h: 0.3 });
    expect(s.objects[0]!.placement).toBe("center");
    s = reduce(s, { type: "stage", command: { cmd: "unpin", id: "a" } });
    expect(s.objects[0]!.pinned).toBeUndefined();
  });

  it("remembers who spoke last, and by name for a family member", () => {
    const s = reduce(initialState, { type: "voice.heard", text: "hi", trust: "member", speaker: "Priya" });
    expect(s.speaker).toEqual({ name: "Priya", trust: "member", seq: 1 });
    expect(reduce(s, { type: "voice.heard", text: "hello", trust: "owner" }).speaker).toEqual({ name: null, trust: "owner", seq: 2 });
  });
});

describe("telling the server what the screen is", () => {
  it("tells a phone, a tablet and a desktop apart, and portrait from landscape", () => {
    expect(classifyScreen(390, 844, true)).toEqual({ width: 390, height: 844, kind: "phone", orientation: "portrait", touch: true });
    expect(classifyScreen(844, 390, true)).toMatchObject({ kind: "tablet", orientation: "landscape" }); // a phone on its side is wider than a column
    expect(classifyScreen(820, 1180, true)).toMatchObject({ kind: "tablet", orientation: "portrait" });
    expect(classifyScreen(1920, 1080, false)).toMatchObject({ kind: "desktop", orientation: "landscape", touch: false });
    expect(classifyScreen(800, 600, false)).toMatchObject({ kind: "tablet" });
  });

  it("reports once the connection is open, and again (once) after the window changes size", () => {
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: q.includes("coarse"), media: q, addEventListener() {}, removeEventListener() {} }));
    const sent: ClientMsg[] = [];
    const send = (m: ClientMsg) => sent.push(m);
    const set = (w: number, h: number) => {
      Object.defineProperty(window, "innerWidth", { value: w, configurable: true });
      Object.defineProperty(window, "innerHeight", { value: h, configurable: true });
    };
    set(390, 844);
    const { rerender } = renderHook(({ c }: { c: "connecting" | "open" }) => useScreenReport(send, c), { initialProps: { c: "connecting" as "connecting" | "open" } });
    expect(sent).toEqual([]);
    rerender({ c: "open" });
    expect(sent).toEqual([{ type: "ui.screen", width: 390, height: 844, kind: "phone", orientation: "portrait", touch: true }]);

    set(844, 390); // turned on its side
    act(() => {
      window.dispatchEvent(new Event("resize"));
      window.dispatchEvent(new Event("resize"));
      vi.advanceTimersByTime(500);
    });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ width: 844, height: 390, orientation: "landscape" });

    act(() => {
      window.dispatchEvent(new Event("resize")); // nothing changed: nothing to say
      vi.advanceTimersByTime(500);
    });
    expect(sent).toHaveLength(2);
  });
});

describe("the profile badge", () => {
  it("shows the owner by default, and 'Owner' when no name is set", () => {
    render(<ProfileBadge ownerName="Deepak" speaker={null} />);
    expect(screen.getByText("Deepak")).toBeTruthy();
    expect(screen.getByText("signed in")).toBeTruthy();
    cleanup();
    render(<ProfileBadge ownerName="" speaker={null} />);
    expect(screen.getByText("Owner")).toBeTruthy();
  });

  it("shows a recognized family member while they talk, then goes back to the owner", () => {
    vi.useFakeTimers();
    const { rerender } = render(<ProfileBadge ownerName="Deepak" speaker={null} />);
    rerender(<ProfileBadge ownerName="Deepak" speaker={{ name: "Priya", trust: "member", seq: 1 }} />);
    expect(screen.getByText("Priya")).toBeTruthy();
    expect(screen.getByText("family")).toBeTruthy();
    act(() => {
      vi.advanceTimersByTime(SPEAKER_MS + 100);
    });
    expect(screen.getByText("Deepak")).toBeTruthy();
    expect(screen.queryByText("Priya")).toBeNull();
  });

  it("shows an unrecognized voice as a guest", () => {
    render(<ProfileBadge ownerName="Deepak" speaker={{ name: null, trust: "guest", seq: 1 }} />);
    expect(screen.getByText("Guest")).toBeTruthy();
  });
});

describe("widgets on the stage", () => {
  const mount = (objects: unknown[], send: (m: ClientMsg) => void = () => {}, width = 1280) => {
    Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
    return render(<Stage state={stageWith(objects)} send={send} dispatch={() => {}} />);
  };

  it("has a pin button that pins, and one that unpins a pinned widget", () => {
    const send = vi.fn();
    mount([card("a"), card("b", { pinned: true })], send);
    fireEvent.click(screen.getByRole("button", { name: "Pin a to the screen" }));
    expect(send).toHaveBeenCalledWith({ type: "stage.pin", objectId: "a", pinned: true });
    fireEvent.click(screen.getByRole("button", { name: "Unpin b" }));
    expect(send).toHaveBeenCalledWith({ type: "stage.pin", objectId: "b", pinned: false });
  });

  it("marks a pinned widget so it looks different", () => {
    const { container } = mount([card("b", { pinned: true }), card("a")]);
    expect(container.querySelector('[data-object="b"]')!.className).toContain("pinned");
    expect(container.querySelector('[data-object="a"]')!.className).not.toContain("pinned");
  });

  it("can be moved with the arrow keys on the grip: the new box goes to the server", () => {
    const send = vi.fn();
    const { container } = mount([card("a", { placement: { x: 0.3, y: 0.3, w: 0.3, h: 0.3 } })], send);
    const stage = container.querySelector(".stage") as HTMLElement;
    const rect = (l: number, t: number, w: number, h: number) => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t, toJSON: () => ({}) });
    stage.getBoundingClientRect = () => rect(0, 0, 1000, 500) as DOMRect;
    (container.querySelector('[data-object="a"]') as HTMLElement).getBoundingClientRect = () => rect(300, 150, 300, 150) as DOMRect;
    fireEvent.keyDown(screen.getByRole("button", { name: /Move a/ }), { key: "ArrowRight" });
    expect(send).toHaveBeenCalledWith({ type: "stage.move", objectId: "a", rect: { x: 0.32, y: 0.3, w: 0.3, h: 0.3 } });
    fireEvent.keyDown(screen.getByRole("button", { name: /Move a/ }), { key: "ArrowDown", shiftKey: true }); // shift resizes
    expect(send).toHaveBeenLastCalledWith({ type: "stage.move", objectId: "a", rect: { x: 0.3, y: 0.3, w: 0.3, h: 0.32 } });
  });

  it("drags with the pointer and sends the final box once, on release", () => {
    const send = vi.fn();
    const { container } = mount([card("a", { placement: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 } })], send);
    const stage = container.querySelector(".stage") as HTMLElement;
    const rect = (l: number, t: number, w: number, h: number) => ({ left: l, top: t, width: w, height: h, right: l + w, bottom: t + h, x: l, y: t, toJSON: () => ({}) });
    stage.getBoundingClientRect = () => rect(0, 0, 1000, 500) as DOMRect;
    (container.querySelector('[data-object="a"]') as HTMLElement).getBoundingClientRect = () => rect(100, 100, 300, 150) as DOMRect;
    const grip = screen.getByRole("button", { name: /Move a/ });
    fireEvent.pointerDown(grip, { pointerId: 1, clientX: 150, clientY: 110, button: 0 });
    fireEvent.pointerMove(grip, { pointerId: 1, clientX: 350, clientY: 210 }); // 200px right, 100px down = 0.2 and 0.2
    expect(send).not.toHaveBeenCalled(); // while dragging nothing is sent
    fireEvent.pointerUp(grip, { pointerId: 1, clientX: 350, clientY: 210 });
    expect(send).toHaveBeenCalledTimes(1);
    const msg = send.mock.calls[0]![0] as { rect: { x: number; y: number; w: number; h: number } };
    expect(msg.rect.x).toBeCloseTo(0.3);
    expect(msg.rect.y).toBeCloseTo(0.4);
    expect(msg.rect.w).toBeCloseTo(0.3);
  });

  it("a cancelled drag sends nothing", () => {
    const send = vi.fn();
    const { container } = mount([card("a", { placement: { x: 0.1, y: 0.2, w: 0.3, h: 0.3 } })], send);
    const stage = container.querySelector(".stage") as HTMLElement;
    stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 1000, height: 500, right: 1000, bottom: 500, x: 0, y: 0, toJSON: () => ({}) }) as DOMRect;
    const grip = screen.getByRole("button", { name: /Move a/ });
    fireEvent.pointerDown(grip, { pointerId: 2, clientX: 10, clientY: 10, button: 0 });
    fireEvent.pointerCancel(grip, { pointerId: 2 });
    expect(send).not.toHaveBeenCalled();
  });

  it("offers no dragging on a phone, where everything stacks, but still the pin", () => {
    mount([card("a")], () => {}, 390);
    expect(screen.queryByRole("button", { name: /Move a/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Pin a to the screen" })).toBeTruthy();
  });

  it("keeps a box inside the stage and not smaller than readable", () => {
    expect(fit({ x: -0.2, y: 0.95, w: 0.4, h: 0.3 })).toEqual({ x: 0, y: 0.7, w: 0.4, h: 0.3 });
    expect(fit({ x: 0.5, y: 0.5, w: 0.01, h: 0.01 })).toMatchObject({ w: 0.12, h: 0.1 });
    expect(fit({ x: 0.9, y: 0, w: 0.5, h: 2 })).toEqual({ x: 0.5, y: 0, w: 0.5, h: 1 });
  });
});

beforeEach(() => {
  Object.defineProperty(window, "innerHeight", { value: 800, configurable: true });
});
