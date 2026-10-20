import type { HudView } from "@friend/protocol";
import { cleanup, render } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { initialState, type StageViewState } from "../../store";
import { OrbitalHud } from "./OrbitalHud";

afterEach(cleanup);

const launcher: HudView["launcher"] = [
  { id: "chat", label: "Chat", icon: "C", action: { type: "panel", value: "chat" } },
  { id: "tasks", label: "Tasks", icon: "T", action: { type: "panel", value: "tasks" } },
  { id: "music", label: "Music", icon: "M", action: { type: "panel", value: "music" } },
];
const hud: HudView = { terminalLabel: "JARVIS TERMINAL", clock: { hour12: true, seconds: false, locale: "" }, launcher, animations: "full", layout: "orbital", density: "full", widgets: {} };
const mount = (state: Partial<StageViewState> = {}) => render(<OrbitalHud hud={hud} state={{ ...initialState, connection: "open", hud, assistantName: "maya", ...state }} viewport={{ w: 1920, h: 1080 }} usage={42} onLaunch={() => {}} onExpand={() => {}} />);
const css = readFileSync(join(process.cwd(), "src/hud/orbital/orbital.css"), "utf8");

describe("the approved mockup, in the parts that do not need workers", () => {
  it("has a notched top line with a running light, the product name spaced out, and the assistant on the left", () => {
    const { container } = mount();
    const bar = container.querySelector('[data-testid="orbital-topbar"]')!;
    expect(bar.textContent).toContain("F R I E N D");
    expect(bar.textContent).toMatch(/MAYA/);
    expect(bar.querySelector("path.ob-topbar-run")).toBeTruthy();
    expect(css).toMatch(/@keyframes ob-runline/);
  });

  it("names the assistant and what its voice is doing in the middle of the orb", () => {
    const { container } = mount({ voice: { ...initialState.voice, mode: "listening" } });
    const label = container.querySelector(".ob-orb-label")!;
    expect(label.textContent).toMatch(/maya/i);
    expect(label.textContent).toMatch(/listening/i);
  });

  it("writes each quick-launch button's name under its node", () => {
    const { container } = mount();
    expect([...container.querySelectorAll(".ob-node-caption")].map((c) => c.textContent)).toEqual(["Chat", "Tasks", "Music"]);
  });

  it("draws the system gauge and the radar as light brackets, not filled boxes", () => {
    const { container } = mount();
    expect(container.querySelector('[data-widget="system"]')!.className).toContain("ob-v-bracket");
    expect(container.querySelector('[data-widget="radar"]')!.className).toContain("ob-v-bracket");
  });

  it("draws the approvals as light brackets while nothing waits, and as the orange octagon when something does", () => {
    const idle = mount();
    expect(idle.container.querySelector('[data-widget="approval"]')!.className).toContain("ob-v-bracket");
    cleanup();
    const waiting = mount({ approval: { id: "a1", tool: "x", summary: "y", tier: "T2", needsPin: false } as never });
    expect(waiting.container.querySelector('[data-widget="approval"]')!.className).toContain("ob-v-octagon");
  });

  it("shows dim placeholder shapes for tickets and budget until workers exist, and says so", () => {
    const { container } = mount();
    const tickets = container.querySelector('[data-widget="tickets"]')!;
    expect(tickets.querySelectorAll("[data-placeholder] [data-status]").length).toBeGreaterThanOrEqual(8);
    expect(tickets.textContent).toMatch(/no workers yet/i);
    const budget = container.querySelector('[data-widget="budget"]')!;
    expect(budget.querySelectorAll("[data-placeholder] [data-ring]").length).toBe(3);
    expect(budget.textContent).toMatch(/no workers yet/i);
  });

  it("lights the usage ring with thick, bright segments", () => {
    expect(css).toMatch(/\.ob-seg \{[^}]*stroke-width: (9|10|11|12)/);
  });
});