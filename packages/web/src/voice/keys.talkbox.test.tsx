import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVoiceKeys } from "./keys";

afterEach(() => {
  document.body.innerHTML = "";
});

const voice = () => ({ pressStart: vi.fn(), pressEnd: vi.fn(), blur: vi.fn() });
const input = (attrs: Record<string, string> = {}, value = "") => {
  const el = document.createElement("input");
  for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
  el.value = value;
  document.body.appendChild(el);
  el.focus();
  return el;
};

describe("Space in the message strip", () => {
  it("talks when the strip is empty, and does not type a space", () => {
    const v = voice();
    renderHook(() => useVoiceKeys(v));
    const el = input({ "data-space-talks": "" });
    const notPrevented = fireEvent.keyDown(el, { key: " ", code: "Space" });
    expect(notPrevented).toBe(false); // default prevented: no space is typed
    expect(v.pressStart).toHaveBeenCalledTimes(1);
    fireEvent.keyUp(el, { key: " ", code: "Space" });
    expect(v.pressEnd).toHaveBeenCalledTimes(1);
  });

  it("types a space once there is text in the strip", () => {
    const v = voice();
    renderHook(() => useVoiceKeys(v));
    const el = input({ "data-space-talks": "" }, "hello");
    expect(fireEvent.keyDown(el, { key: " ", code: "Space" })).toBe(true);
    expect(v.pressStart).not.toHaveBeenCalled();
  });

  it("leaves every other text box alone: Space types there", () => {
    const v = voice();
    renderHook(() => useVoiceKeys(v));
    const el = input();
    expect(fireEvent.keyDown(el, { key: " ", code: "Space" })).toBe(true);
    expect(v.pressStart).not.toHaveBeenCalled();
  });
});