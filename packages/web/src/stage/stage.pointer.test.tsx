import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initialState } from "../store";
import { Stage } from "./Stage";

const state = { ...initialState, connection: "open" as const };
const noop = () => {};
const voiceMock = () => ({ pressStart: vi.fn(), pressEnd: vi.fn(), blur: vi.fn() });

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("long-press talk: pointer edge cases", () => {
  it("a pointer cancel during a long press discards the recording instead of sending it", () => {
    const v = voiceMock();
    render(<Stage state={state} send={noop} dispatch={noop} voice={v} />);
    const stage = screen.getByTestId("stage");
    fireEvent.pointerDown(stage, { pointerId: 1 });
    act(() => void vi.advanceTimersByTime(400));
    expect(v.pressStart).toHaveBeenCalledTimes(1);
    fireEvent.pointerCancel(stage, { pointerId: 1 });
    expect(v.blur).toHaveBeenCalledTimes(1);
    expect(v.pressEnd).not.toHaveBeenCalled();
  });

  it("a second finger does not start a second press or end the first one", () => {
    const v = voiceMock();
    render(<Stage state={state} send={noop} dispatch={noop} voice={v} />);
    const stage = screen.getByTestId("stage");
    fireEvent.pointerDown(stage, { pointerId: 5, pointerType: "touch" });
    fireEvent.pointerDown(stage, { pointerId: 6, pointerType: "touch" });
    fireEvent.pointerUp(stage, { pointerId: 6, pointerType: "touch" }); // the second finger lifts: ignored
    act(() => void vi.advanceTimersByTime(400));
    expect(v.pressStart).toHaveBeenCalledTimes(1);
    expect(v.pressEnd).not.toHaveBeenCalled();
    fireEvent.pointerUp(stage, { pointerId: 5, pointerType: "touch" });
    expect(v.pressEnd).toHaveBeenCalledTimes(1);
  });

  it("if the first finger lifts before the long press, nothing talks even when a second finger was down", () => {
    const v = voiceMock();
    render(<Stage state={state} send={noop} dispatch={noop} voice={v} />);
    const stage = screen.getByTestId("stage");
    fireEvent.pointerDown(stage, { pointerId: 1, pointerType: "touch" });
    act(() => void vi.advanceTimersByTime(100));
    fireEvent.pointerDown(stage, { pointerId: 2, pointerType: "touch" });
    fireEvent.pointerUp(stage, { pointerId: 1, pointerType: "touch" }); // a tap
    act(() => void vi.advanceTimersByTime(1000));
    expect(v.pressStart).not.toHaveBeenCalled();
  });

  it("ignores right and middle mouse buttons", () => {
    const v = voiceMock();
    render(<Stage state={state} send={noop} dispatch={noop} voice={v} />);
    const stage = screen.getByTestId("stage");
    fireEvent.pointerDown(stage, { pointerId: 1, pointerType: "mouse", button: 2 });
    fireEvent.pointerDown(stage, { pointerId: 1, pointerType: "mouse", button: 1 });
    act(() => void vi.advanceTimersByTime(1000));
    expect(v.pressStart).not.toHaveBeenCalled();
  });

  it("captures the pointer so a release outside the stage still reaches it", () => {
    const v = voiceMock();
    render(<Stage state={state} send={noop} dispatch={noop} voice={v} />);
    const stage = screen.getByTestId("stage") as HTMLElement & { setPointerCapture?: (id: number) => void };
    const capture = vi.fn();
    stage.setPointerCapture = capture;
    fireEvent.pointerDown(stage, { pointerId: 7 });
    expect(capture).toHaveBeenCalledWith(7);
  });

  it("a quick tap followed by a new press does not stack timers", () => {
    const v = voiceMock();
    render(<Stage state={state} send={noop} dispatch={noop} voice={v} />);
    const stage = screen.getByTestId("stage");
    fireEvent.pointerDown(stage, { pointerId: 1 });
    fireEvent.pointerUp(stage, { pointerId: 1 });
    fireEvent.pointerDown(stage, { pointerId: 1 });
    act(() => void vi.advanceTimersByTime(400));
    expect(v.pressStart).toHaveBeenCalledTimes(1);
  });
});
