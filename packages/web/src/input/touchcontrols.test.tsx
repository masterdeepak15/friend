import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../store";
import { Stage } from "../stage/Stage";
import { HOLD_MS, TouchControls } from "./TouchControls";

const voiceMock = () => ({ pressStart: vi.fn(), pressEnd: vi.fn(), blur: vi.fn() });
const mic = () => screen.getByRole("button", { name: "Talk to Friend" });

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(mode: "idle" | "listening" | "transcribing" | "speaking" = "idle") {
  const v = voiceMock();
  const onType = vi.fn();
  const onMenu = vi.fn();
  const view = render(<TouchControls voice={v} mode={mode} onType={onType} onMenu={onMenu} />);
  return { v, onType, onMenu, ...view };
}

describe("touch controls", () => {
  it("holding the microphone talks, and letting go sends", () => {
    const { v } = setup();
    fireEvent.pointerDown(mic(), { pointerId: 1, pointerType: "touch" });
    expect(v.pressStart).toHaveBeenCalledTimes(1);
    act(() => void vi.advanceTimersByTime(HOLD_MS + 50));
    fireEvent.pointerUp(mic(), { pointerId: 1, pointerType: "touch" });
    expect(v.pressEnd).toHaveBeenCalledTimes(1);
  });

  it("a quick tap keeps listening, and the next tap sends", () => {
    const { v, rerender, onType, onMenu } = setup();
    fireEvent.pointerDown(mic(), { pointerId: 1, pointerType: "touch" });
    act(() => void vi.advanceTimersByTime(100));
    fireEvent.pointerUp(mic(), { pointerId: 1, pointerType: "touch" });
    expect(v.pressEnd).not.toHaveBeenCalled(); // still listening
    rerender(<TouchControls voice={v} mode="listening" onType={onType} onMenu={onMenu} />);
    expect(screen.getByText(/tap to send/)).toBeTruthy();
    fireEvent.pointerDown(mic(), { pointerId: 2, pointerType: "touch" });
    expect(v.pressEnd).toHaveBeenCalledTimes(1);
    expect(v.pressStart).toHaveBeenCalledTimes(1); // the second tap did not start another recording
    fireEvent.pointerUp(mic(), { pointerId: 2, pointerType: "touch" });
    expect(v.pressEnd).toHaveBeenCalledTimes(1);
  });

  it("if listening stopped by itself, the next tap starts again instead of sending", () => {
    const { v, rerender, onType, onMenu } = setup();
    fireEvent.pointerDown(mic(), { pointerId: 1, pointerType: "touch" });
    fireEvent.pointerUp(mic(), { pointerId: 1, pointerType: "touch" });
    rerender(<TouchControls voice={v} mode="listening" onType={onType} onMenu={onMenu} />);
    rerender(<TouchControls voice={v} mode="idle" onType={onType} onMenu={onMenu} />); // a time limit or a lost microphone
    fireEvent.pointerDown(mic(), { pointerId: 3, pointerType: "touch" });
    expect(v.pressStart).toHaveBeenCalledTimes(2);
    expect(v.pressEnd).not.toHaveBeenCalled();
  });

  it("a cancelled touch discards the recording", () => {
    const { v } = setup();
    fireEvent.pointerDown(mic(), { pointerId: 1, pointerType: "touch" });
    fireEvent.pointerCancel(mic(), { pointerId: 1, pointerType: "touch" });
    expect(v.blur).toHaveBeenCalledTimes(1);
    expect(v.pressEnd).not.toHaveBeenCalled();
  });

  it("a second finger does not start a second recording", () => {
    const { v } = setup();
    fireEvent.pointerDown(mic(), { pointerId: 1, pointerType: "touch" });
    fireEvent.pointerDown(mic(), { pointerId: 2, pointerType: "touch" });
    expect(v.pressStart).toHaveBeenCalledTimes(1);
  });

  it("the type and menu buttons call back", () => {
    const { onType, onMenu } = setup();
    fireEvent.click(screen.getByRole("button", { name: "Type a message" }));
    fireEvent.click(screen.getByRole("button", { name: "Open the menu" }));
    expect(onType).toHaveBeenCalledTimes(1);
    expect(onMenu).toHaveBeenCalledTimes(1);
  });

  it("says what is happening in words", () => {
    setup("idle");
    expect(screen.getByText(/Hold to talk/)).toBeTruthy();
    cleanup();
    setup("transcribing");
    expect(screen.getByText(/Understanding/)).toBeTruthy();
  });
});

describe("the stage on a phone", () => {
  const state = { ...initialState, connection: "open" as const };
  const phone = (coarse: boolean) =>
    vi.stubGlobal("matchMedia", (q: string) => ({ matches: coarse && q.includes("coarse"), media: q, addEventListener() {}, removeEventListener() {} }));

  it("shows the buttons on a touch screen only", () => {
    phone(true);
    render(<Stage state={state} send={() => {}} dispatch={() => {}} voice={voiceMock()} onMenu={() => {}} />);
    expect(screen.getByTestId("touch-controls")).toBeTruthy();
    cleanup();
    phone(false);
    render(<Stage state={state} send={() => {}} dispatch={() => {}} voice={voiceMock()} onMenu={() => {}} />);
    expect(screen.queryByTestId("touch-controls")).toBeNull();
  });

  it("the keyboard button opens the message bar and the buttons step aside for it", () => {
    phone(true);
    render(<Stage state={state} send={() => {}} dispatch={() => {}} voice={voiceMock()} onMenu={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: "Type a message" }));
    expect(screen.getByLabelText("Message")).toBeTruthy();
    expect(screen.queryByTestId("touch-controls")).toBeNull();
  });

  it("the menu button asks for the owner menu", () => {
    phone(true);
    const onMenu = vi.fn();
    render(<Stage state={state} send={() => {}} dispatch={() => {}} voice={voiceMock()} onMenu={onMenu} />);
    fireEvent.click(screen.getByRole("button", { name: "Open the menu" }));
    expect(onMenu).toHaveBeenCalledTimes(1);
  });
});
