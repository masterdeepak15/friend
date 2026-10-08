import { fireEvent, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useVoiceKeys } from "./keys";

const make = () => ({ pressStart: vi.fn(), pressEnd: vi.fn(), blur: vi.fn() });
const press = (target: Element | Window = window) => fireEvent.keyDown(target, { key: " ", code: "Space" });

afterEach(() => {
  document.body.replaceChildren();
});

describe("useVoiceKeys edge cases", () => {
  it("closes a pointer-driven recording too when the window loses focus (Space was not held)", () => {
    const v = make();
    renderHook(() => useVoiceKeys(v));
    fireEvent.blur(window);
    expect(v.blur).toHaveBeenCalledTimes(1);
    expect(v.pressEnd).not.toHaveBeenCalled();
  });

  it("leaves Space alone on summaries and on checkbox, switch, tab, menu item, link, radio and option roles", () => {
    const v = make();
    renderHook(() => useVoiceKeys(v));
    for (const role of ["checkbox", "switch", "tab", "menuitem", "link", "radio", "option"]) {
      const el = document.createElement("div");
      el.setAttribute("role", role);
      el.tabIndex = 0;
      document.body.appendChild(el);
      el.focus();
      press(el);
    }
    const summary = document.createElement("summary");
    document.body.appendChild(summary);
    press(summary);
    expect(v.pressStart).not.toHaveBeenCalled();
  });
});
