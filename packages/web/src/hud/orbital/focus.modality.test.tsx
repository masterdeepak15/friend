import type { HudView } from "@friend/protocol";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState } from "../../store";
import { OrbitalHud } from "./OrbitalHud";

afterEach(cleanup);

const hud: HudView = { terminalLabel: "T", clock: { hour12: true, seconds: false, locale: "" }, launcher: [], animations: "full", layout: "orbital", density: "standard", widgets: {} };
const mount = () => render(<OrbitalHud hud={hud} state={{ ...initialState, connection: "open", hud }} viewport={{ w: 1600, h: 900 }} usage={42} onLaunch={() => {}} onExpand={() => {}} />);
const usage = () => screen.getByRole("button", { name: /usage/i });

describe("where the focus goes when a dialog opens and closes", () => {
  it("stays off the buttons after the mouse, so Space is still the talk key", () => {
    mount();
    fireEvent.pointerDown(usage());
    fireEvent.click(usage(), { detail: 1 });
    expect(screen.getByRole("dialog", { name: /usage/i })).toBeTruthy();
    expect(document.activeElement?.tagName).not.toBe("BUTTON"); // not the close mark
    fireEvent.click(screen.getByRole("button", { name: "Close" }), { detail: 1 });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement?.tagName).not.toBe("BUTTON"); // not the instrument that opened it
  });

  it("goes into the dialog and back to the button for someone using the keyboard", () => {
    mount();
    fireEvent.keyDown(document.body, { key: "Tab" });
    usage().focus();
    fireEvent.click(usage(), { detail: 0 });
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Close" }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }), { detail: 0 });
    expect(document.activeElement).toBe(usage());
  });
});