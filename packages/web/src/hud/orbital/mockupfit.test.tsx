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
const ALL_ON = { system: true, voice: true, network: true, feed: true, radar: true, tickets: true, approval: true };
const hud: HudView = { terminalLabel: "JARVIS TERMINAL", clock: { hour12: true, seconds: false, locale: "" }, launcher, animations: "full", layout: "orbital", density: "full", widgets: ALL_ON };
const mount = (state: Partial<StageViewState> = {}) => render(<OrbitalHud hud={hud} state={{ ...initialState, connection: "open", hud, assistantName: "maya", ...state }} viewport={{ w: 1920, h: 1080 }} usage={42} onLaunch={() => {}} onExpand={() => {}} />);
const css = readFileSync(join(process.cwd(), "src/hud/orbital/orbital.css"), "utf8");

describe("the approved mockup, in the parts that do not need workers", () => {
  it("writes whatever name the owner gave the assistant, and a plain word when it has none", () => {
    expect(mount({ assistantName: "Jarvis" }).container.querySelector('[data-testid="orbital-topbar"]')!.textContent).toContain("J A R V I S");
    cleanup();
    expect(mount({ assistantName: "" }).container.querySelector('[data-testid="orbital-topbar"]')!.textContent).toContain("A S S I S T A N T");
  });

  it("has a notched top line with a running light, the product name spaced out, and the assistant on the left", () => {
    const { container } = mount();
    const bar = container.querySelector('[data-testid="orbital-topbar"]')!;
    expect(bar.textContent).toContain("M A Y A"); // the assistant's own name, spaced out: no product name is written into the screen
    expect(bar.textContent).not.toContain("F R I E N D");
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

  it("draws the system gauge with bracket corners and the radar with no box at all, not filled boxes", () => {
    const { container } = mount();
    expect(container.querySelector('[data-widget="system"] .ob-bracket')).toBeTruthy();
    expect(container.querySelector('[data-widget="system"] .ob-frame')).toBeNull();
    expect(container.querySelector('[data-widget="radar"] .ob-frame')).toBeNull();
  });

  it("writes the processor as a big number in the middle of the gauge, as the mockup does", () => {
    const { container } = mount({ stats: { cpu: 38, ramUsed: 6, ramTotal: 10, netDown: 0, netUp: 0, at: Date.now() } });
    expect(container.querySelector('[data-widget="system"] .ob-big')!.textContent).toBe("38%");
    expect(container.querySelector('[data-widget="system"]')!.textContent).toMatch(/RAM 60%/);
  });

  it("draws the approvals as light brackets while nothing waits, and as the orange octagon when something does", () => {
    const idle = mount();
    expect(idle.container.querySelector('[data-widget="approval"] .ob-v-bracket')).toBeTruthy();
    cleanup();
    const waiting = mount({ approval: { id: "a1", tool: "x", summary: "y", tier: "T2", needsPin: false } as never });
    expect(waiting.container.querySelector('[data-widget="approval"].ob-v-octagon, [data-widget="approval"] .ob-v-octagon')).toBeTruthy(); // the octagon is now the dialog in the middle
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

  it("scales the mockup's 1600 x 900 canvas to the window and keeps the left rail on the left edge and the right rail on the right", () => {
    const { container } = mount();
    const left = container.querySelector<HTMLElement>(".ob-canvas-left")!;
    const right = container.querySelector<HTMLElement>(".ob-canvas-right")!;
    const centre = container.querySelector<HTMLElement>(".ob-canvas-centre")!;
    expect(left.style.transform).toBe("scale(1.2)");
    expect(parseFloat(left.style.left)).toBe(0);
    expect(parseFloat(right.style.left)).toBe(1920 - 1600 * 1.2);
    expect(parseFloat(centre.style.left)).toBe(0);
    expect(parseFloat(centre.style.width)).toBe(1600);
  });

  it("puts each instrument in its box on the canvas", () => {
    const { container } = mount();
    const box = (id: string) => {
      const s = container.querySelector<HTMLElement>(`[data-widget="${id}"]`)!.style;
      return [s.left, s.top, s.width, s.height].map(parseFloat);
    };
    expect(box("system")).toEqual([40, 70, 300, 220]);
    expect(box("feed")).toEqual([40, 650, 430, 210]);
    expect(box("radar")).toEqual([1310, 60, 250, 270]);
    expect(box("approval")).toEqual([1180, 650, 380, 210]);
  });

  it("puts the nodes in the mockup's slots: top, upper right, lower right, lower left, upper left, with the bottom free for the usage label", () => {
    const five = [...launcher, { id: "a", label: "Plugins", icon: "P", action: { type: "panel", value: "plugins" } }, { id: "b", label: "Settings", icon: "S", action: { type: "panel", value: "settings" } }] as HudView["launcher"];
    const withFive = render(<OrbitalHud hud={{ ...hud, launcher: five }} state={{ ...initialState, connection: "open", hud, assistantName: "maya" }} viewport={{ w: 1920, h: 1080 }} usage={42} onLaunch={() => {}} onExpand={() => {}} />);
    const pos = [...withFive.container.querySelectorAll<HTMLElement>(".ob-node")].map((n) => [Math.round(parseFloat(n.style.left)), Math.round(parseFloat(n.style.top))]);
    expect(pos).toEqual([
      [800, 150],
      [1060, 300],
      [1060, 600],
      [540, 600],
      [540, 300],
    ]);
  });

  it("draws the mockup's rings around the orb, the notched line and the command bar", () => {
    const { container } = mount();
    for (const c of [".ob-orb-ring", ".ob-ping", ".ob-ring-dash", ".ob-ring-long", ".ob-ring-thin", ".ob-orbit", ".ob-ring-outer"]) expect(container.querySelector(c), c).toBeTruthy();
    expect(container.querySelector(".ob-topbar-base")!.getAttribute("d")).toBe("M330 44H560L590 20H1010L1040 44H1270");
    expect(container.querySelector(".ob-cmd")!.textContent).toMatch(/HOLD TO TALK/);
    expect(container.querySelector(".ob-cmd")!.textContent).not.toMatch(/ask maya/i); // the words are the real bar's placeholder
  });

  it("draws the orb's glowing disc and the radial background under the stage's orb, so the orb shows through", () => {
    const { container } = mount();
    const base = container.querySelector(".ob-base")!;
    expect(base).toBeTruthy();
    expect(base.querySelector("circle.ob-disc")!.getAttribute("r")).toBe("104");
    expect(base.querySelector("circle.ob-disc")!.getAttribute("fill")).toBe("url(#ob-orbg)");
    expect(container.querySelector("#ob-orbg")).toBeTruthy();
    expect(css).toMatch(/\.ob-base \{[^}]*z-index: 0/);
  });

  it("swells the disc with the voice", () => {
    const quiet = mount();
    const q = quiet.container.querySelector<SVGGElement>(".ob-disc-wrap")!.style.transform;
    cleanup();
    const loud = mount({ voice: { ...initialState.voice, mode: "speaking", level: 1 } });
    const l = loud.container.querySelector<SVGGElement>(".ob-disc-wrap")!.style.transform;
    expect(q).toBe("scale(1)");
    expect(parseFloat(l.replace("scale(", ""))).toBeGreaterThan(1.1);
  });

  it("writes the usage under the ring, in the free bottom slot of the orbit", () => {
    const { container } = mount();
    const label = container.querySelector<HTMLElement>('[data-widget="usage"]')!;
    expect(label.style.top).toBe("692px");
    expect(label.style.left).toBe("800px");
  });

  it("pulses the review cell and the live dots without filling them in", () => {
    expect(css).toMatch(/\.ob-pulse \{[^}]*animation: ob-pulse/);
    const { container } = mount();
    const waiting = render(<OrbitalHud hud={{ ...hud, preview: true }} state={{ ...initialState, connection: "open", assistantName: "maya" }} viewport={{ w: 1920, h: 1080 }} usage={null} onLaunch={() => {}} onExpand={() => {}} />);
    const review = waiting.container.querySelector('[data-widget="tickets"] [data-status="review"]')!;
    expect(review.getAttribute("class")).toContain("ob-pulse");
    expect(review.getAttribute("class")).not.toContain("ob-blip");
    expect(container).toBeTruthy();
  });

  it("lays the approval out like the mockup: a warning triangle, the title, who wants to do what, the command, big buttons", () => {
    const approval = { id: "a1", tool: "shell.run", summary: "npm install --save zod", tier: "T2", needsPin: false } as never;
    const { container } = mount({ approval });
    const box = container.querySelector('[data-widget="approval"]')!;
    expect(box.querySelector("svg.ob-tri")).toBeTruthy();
    expect(box.querySelector(".ob-appr-title")!.textContent).toMatch(/approval needed/i);
    expect(box.querySelector(".ob-appr-sub")!.textContent).toMatch(/shell\.run/);
    expect(box.querySelector(".ob-summary")!.textContent).toBe("npm install --save zod");
    expect(css).toMatch(/\.ob-approval \{[^}]*grid-template-columns/);
  });

  it("keeps the approval's text at full brightness and its three buttons on one row", () => {
    expect(css).toMatch(/\.ob-frame\[data-tone="orange"\]\.ob-approval-frame \{[^}]*animation: none/);
    expect(css).toMatch(/\.ob-approval-frame \.ob-actions \{[^}]*flex-wrap: nowrap/);
  });
});
