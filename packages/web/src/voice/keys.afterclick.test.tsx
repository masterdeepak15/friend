import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVoiceKeys } from "./keys";

const make = () => ({ pressStart: vi.fn(), pressEnd: vi.fn(), blur: vi.fn() });
const press = (target: Element | Window = window) => fireEvent.keyDown(target, { key: " ", code: "Space" });
const button = () => {
  const b = document.createElement("button");
  document.body.appendChild(b);
  return b;
};
const later = () => new Promise((r) => setTimeout(r, 5));

afterEach(() => {
  document.body.innerHTML = "";
});

describe("Space after a button was clicked", () => {
  it("still means talk: a mouse click leaves no focus on the button to swallow it", async () => {
    const v = make();
    renderHook(() => useVoiceKeys(v));
    const b = button();
    b.focus();
    fireEvent.click(b, { detail: 1 }); // a real mouse click
    await later();
    expect(document.activeElement).not.toBe(b);
    press(document.body); // keys go to the page when nothing has the focus
    expect(v.pressStart).toHaveBeenCalledTimes(1);
  });

  it("keeps the keyboard's own use of Space: a button reached with Tab and pressed with Space is a button press", async () => {
    const v = make();
    renderHook(() => useVoiceKeys(v));
    const b = button();
    b.focus();
    fireEvent.click(b, { detail: 0 }); // what the keyboard makes
    await later();
    expect(document.activeElement).toBe(b);
    press(b);
    expect(v.pressStart).not.toHaveBeenCalled();
  });

  it("does not take the focus from a field that was clicked", async () => {
    const v = make();
    renderHook(() => useVoiceKeys(v));
    const input = document.createElement("input");
    document.body.appendChild(input);
    input.focus();
    fireEvent.click(input, { detail: 1 });
    await later();
    expect(document.activeElement).toBe(input);
  });

  it("leaves a dialog's own focus alone when the click opened it", async () => {
    const v = make();
    renderHook(() => useVoiceKeys(v));
    const opener = button();
    const close = button();
    opener.focus();
    fireEvent.click(opener, { detail: 1 });
    close.focus(); // the dialog moves the focus into itself
    await later();
    expect(document.activeElement).toBe(close);
  });
});