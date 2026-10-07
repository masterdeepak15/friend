import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVoiceKeys } from "./keys";

const make = () => ({ pressStart: vi.fn(), pressEnd: vi.fn(), blur: vi.fn() });
const press = (extra: KeyboardEventInit = {}, target: Element | Window = window) =>
  fireEvent.keyDown(target, { key: " ", code: "Space", ...extra });
const release = (target: Element | Window = window) => fireEvent.keyUp(target, { key: " ", code: "Space" });

afterEach(() => {
  document.body.innerHTML = "";
});

describe("useVoiceKeys", () => {
  it("starts on Space down and ends on Space up", () => {
    const v = make();
    renderHook(() => useVoiceKeys(v));
    press();
    expect(v.pressStart).toHaveBeenCalledTimes(1);
    release();
    expect(v.pressEnd).toHaveBeenCalledTimes(1);
  });

  it("ignores key repeat while the key is held", () => {
    const v = make();
    renderHook(() => useVoiceKeys(v));
    press();
    press({ repeat: true });
    press({ repeat: true });
    expect(v.pressStart).toHaveBeenCalledTimes(1);
  });

  it("ignores Space while typing in a field, and the matching release", () => {
    const v = make();
    renderHook(() => useVoiceKeys(v));
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    press({}, input);
    release(input);
    expect(v.pressStart).not.toHaveBeenCalled();
    expect(v.pressEnd).not.toHaveBeenCalled();
  });

  it("ignores Space combined with modifier keys", () => {
    const v = make();
    renderHook(() => useVoiceKeys(v));
    press({ ctrlKey: true });
    press({ metaKey: true });
    press({ altKey: true });
    expect(v.pressStart).not.toHaveBeenCalled();
  });

  it("a release without a handled press does nothing", () => {
    const v = make();
    renderHook(() => useVoiceKeys(v));
    release();
    expect(v.pressEnd).not.toHaveBeenCalled();
  });

  it("other keys do nothing", () => {
    const v = make();
    renderHook(() => useVoiceKeys(v));
    fireEvent.keyDown(window, { key: "a", code: "KeyA" });
    fireEvent.keyUp(window, { key: "a", code: "KeyA" });
    expect(v.pressStart).not.toHaveBeenCalled();
    expect(v.pressEnd).not.toHaveBeenCalled();
  });

  it("prevents the page from scrolling or clicking a focused button on Space", () => {
    const v = make();
    renderHook(() => useVoiceKeys(v));
    const ev = new KeyboardEvent("keydown", { key: " ", code: "Space", cancelable: true });
    window.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
  });

  it("closes the microphone when the window loses focus", () => {
    const v = make();
    renderHook(() => useVoiceKeys(v));
    press();
    fireEvent.blur(window);
    expect(v.blur).toHaveBeenCalledTimes(1);
    release(); // the release after a blur must not end a recording that is already gone
    expect(v.pressEnd).not.toHaveBeenCalled();
  });

  it("also closes the microphone when the tab becomes hidden", () => {
    const v = make();
    renderHook(() => useVoiceKeys(v));
    press();
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    fireEvent(document, new Event("visibilitychange"));
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    expect(v.blur).toHaveBeenCalledTimes(1);
  });

  it("stops listening after unmount", () => {
    const v = make();
    const { unmount } = renderHook(() => useVoiceKeys(v));
    unmount();
    press();
    expect(v.pressStart).not.toHaveBeenCalled();
  });
});
