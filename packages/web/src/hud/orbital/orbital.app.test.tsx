import type { HudView } from "@friend/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { StageApp } from "../../App";
import { initialState, type StageViewState } from "../../store";
import { useFriend } from "../../useFriend";

vi.mock("../../useFriend", () => ({ useFriend: vi.fn() }));

const voice = { pressStart() {}, pressEnd() {}, blur() {}, unlock() {}, setQuiet() {} };
const hud = (layout: HudView["layout"]): HudView => ({ terminalLabel: "T", clock: { hour12: true, seconds: false, locale: "" }, launcher: [], animations: "full", layout, density: "standard", widgets: {} });

function show(over: Partial<StageViewState>) {
  (useFriend as Mock).mockReturnValue({ state: { ...initialState, connection: "open", deviceOnline: true, viewKnown: true, view: "companion", ...over }, send: vi.fn(), dispatch: vi.fn(), voice, handsFree: { on: false, supported: false, toggle() {} } });
}

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => [] })));
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the orbital layout in the app", () => {
  it("draws the HUD and not the classic corner widgets when the layout is orbital", () => {
    show({ hud: hud("orbital") });
    const { container } = render(<StageApp onSignedOut={() => {}} />);
    expect(container.querySelector(".orbital")).toBeTruthy();
    expect(screen.queryByTestId("status-badge")).toBeNull();
    expect(screen.queryByTestId("clock")).toBeNull();
  });

  it("is exactly the classic screen when the layout is classic", () => {
    show({ hud: hud("classic") });
    const { container } = render(<StageApp onSignedOut={() => {}} />);
    expect(container.querySelector(".orbital")).toBeNull();
    expect(screen.queryByTestId("status-badge")).toBeTruthy();
    expect(screen.queryByTestId("clock")).toBeTruthy();
  });

  it("is the classic screen while the server has not said anything yet", () => {
    show({ hud: null, viewKnown: false });
    const { container } = render(<StageApp onSignedOut={() => {}} />);
    expect(container.querySelector(".orbital")).toBeNull();
  });
});
