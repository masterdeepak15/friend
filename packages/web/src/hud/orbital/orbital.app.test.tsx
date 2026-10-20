import type { HudView } from "@friend/protocol";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { StageApp } from "../../App";
import { ORBITAL_ORB_SCALE } from "./geometry";
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

  it("asks for an approval once: in the HUD's own widget, not also in the old card", () => {
    const approval = { id: "a1", tool: "shell.run", summary: "Run: npm install", tier: "T2", needsPin: false } as never;
    show({ hud: hud("orbital"), approval });
    const { container } = render(<StageApp onSignedOut={() => {}} />);
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
    expect(container.querySelector(".orbital [role='alertdialog']")).toBeTruthy();
    cleanup();
    show({ hud: hud("classic"), approval });
    render(<StageApp onSignedOut={() => {}} />);
    expect(screen.getAllByRole("alertdialog")).toHaveLength(1);
  });

  it("shrinks the orb to sit inside the inner ring, and leaves it alone in the classic layout", () => {
    show({ hud: hud("orbital") });
    const { container } = render(<StageApp onSignedOut={() => {}} />);
    const orb = container.querySelector<HTMLElement>("[data-presence]")!;
    expect(orb.style.transform).toBe(`scale(${ORBITAL_ORB_SCALE})`);
    cleanup();
    show({ hud: hud("classic") });
    const classic = render(<StageApp onSignedOut={() => {}} />);
    expect(classic.container.querySelector<HTMLElement>("[data-presence]")!.style.transform).toBe("");
  });

  it("is drawn inside the stage, between the orb and the pictures the assistant puts up, so those are never hidden behind it", () => {
    show({ hud: hud("orbital") });
    const { container } = render(<StageApp onSignedOut={() => {}} />);
    const stage = container.querySelector('[data-testid="stage"]')!;
    expect(stage.querySelector(".orbital")).toBeTruthy();
    const css = readFileSync(join(process.cwd(), "src/hud/orbital/orbital.css"), "utf8");
    expect(css).toMatch(/\.orbital \{[^}]*position: absolute/);
    expect(css).toMatch(/\.orbital \{[^}]*z-index: 5;/);
  });

  it("keeps the orb at full size on a phone, where there is no orbit to fit it inside", () => {
    const old = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 360, configurable: true, writable: true });
    try {
      show({ hud: hud("orbital") });
      const { container } = render(<StageApp onSignedOut={() => {}} />);
      expect(container.querySelector<HTMLElement>("[data-presence]")!.style.transform).toBe("");
    } finally {
      Object.defineProperty(window, "innerWidth", { value: old, configurable: true, writable: true });
    }
  });

  it("puts the message bar in the HUD's strip, always there, and keeps the hidden bar for the classic screen", () => {
    show({ hud: hud("orbital"), assistantName: "maya" });
    const { container } = render(<StageApp onSignedOut={() => {}} />);
    const form = container.querySelector<HTMLElement>('[data-testid="stage"] .command-bar-hud')!;
    expect(form).toBeTruthy();
    expect(form.querySelector("input")!.placeholder).toBe("▸ ask maya anything…");
    expect(parseFloat(form.style.width)).toBeCloseTo(378 * 0.64, 1); // the strip is 378 canvas units wide; the window scales the canvas by 0.64
    cleanup();
    show({ hud: hud("classic") });
    const classic = render(<StageApp onSignedOut={() => {}} />);
    expect(classic.container.querySelector(".command-bar")).toBeNull();
  });

  it("uses the ordinary hidden bar on a phone, where there is no strip", () => {
    const old = window.innerWidth;
    Object.defineProperty(window, "innerWidth", { value: 360, configurable: true, writable: true });
    try {
      show({ hud: hud("orbital") });
      const { container } = render(<StageApp onSignedOut={() => {}} />);
      expect(container.querySelector(".command-bar-hud")).toBeNull();
    } finally {
      Object.defineProperty(window, "innerWidth", { value: old, configurable: true, writable: true });
    }
  });

  it("keeps the orb in the middle when pictures appear, instead of sending it to the corner over the feed", () => {
    show({ hud: hud("orbital"), scene: "multi" });
    const { container } = render(<StageApp onSignedOut={() => {}} />);
    expect(container.querySelector("[data-presence]")!.className).toContain("presence-full");
    cleanup();
    show({ hud: hud("classic"), scene: "multi" });
    const classic = render(<StageApp onSignedOut={() => {}} />);
    expect(classic.container.querySelector("[data-presence]")!.className).toContain("presence-corner");
  });

  it("lifts the spoken caption above the message strip", () => {
    const css = readFileSync(join(process.cwd(), "src/hud/orbital/orbital.css"), "utf8");
    expect(css).toMatch(/\.stage:has\(\.orbital\[data-mode="orbit"\]\) \.captions \{[^}]*bottom: 1[5-9]%/);
  });
});
