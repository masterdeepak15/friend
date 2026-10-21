import type { HudView } from "@friend/protocol";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { HUD_WIDGET_IDS } from "@friend/protocol";
import { act, cleanup, fireEvent, render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, type StageViewState } from "../../store";
import { OrbitalHud } from "./OrbitalHud";

afterEach(cleanup);

const launcher: HudView["launcher"] = [
  { id: "chat", label: "Chat", icon: "C", action: { type: "panel", value: "chat" } },
  { id: "tasks", label: "Tasks", icon: "T", action: { type: "panel", value: "tasks" } },
  { id: "music", label: "Music", icon: "M", action: { type: "panel", value: "music" } },
];
const hudOf = (over: Partial<HudView> = {}): HudView => ({ terminalLabel: "T", clock: { hour12: true, seconds: false, locale: "" }, launcher, animations: "full", layout: "orbital", density: "standard", widgets: {}, ...over });

function mount(over: Partial<HudView> = {}, state: Partial<StageViewState> = {}, size: [number, number] = [1920, 1080], handlers: { onLaunch?: (i: HudView["launcher"][number]) => void; onExpand?: (e: unknown) => void } = {}) {
  const hud = hudOf(over);
  return render(<OrbitalHud hud={hud} state={{ ...initialState, connection: "open", hud, ...state }} viewport={{ w: size[0], h: size[1] }} usage={42} onLaunch={handlers.onLaunch ?? (() => {})} onExpand={(handlers.onExpand ?? (() => {})) as never} />);
}
const widgetIds = (c: HTMLElement): string[] => [...c.querySelectorAll("[data-widget]")].map((e) => e.getAttribute("data-widget")!).sort();

describe("the orbit", () => {
  it("has a node for each quick-launch button", () => {
    const { container } = mount();
    expect(container.querySelectorAll(".ob-node")).toHaveLength(3);
  });

  it("has no nodes, and no crash, for an empty launcher", () => {
    const { container } = mount({ launcher: [] });
    expect(container.querySelectorAll(".ob-node")).toHaveLength(0);
    expect(container.querySelector(".orbital")).toBeTruthy();
  });

  it("launches a button when its node is clicked", () => {
    const onLaunch = vi.fn();
    const { getByRole } = mount({}, {}, [1920, 1080], { onLaunch });
    fireEvent.click(getByRole("button", { name: "Tasks" }));
    expect(onLaunch).toHaveBeenCalledWith(launcher[1]);
  });
});

describe("the instruments at each density", () => {
  it("calm shows only the usage ring", () => {
    const { container } = mount({ density: "calm" });
    expect(widgetIds(container)).toEqual(["usage"]);
    expect(container.querySelectorAll("[data-seg]")).toHaveLength(60);
  });

  it("calm still shows an approval that is waiting", () => {
    const { container } = mount({ density: "calm" }, { approval: { id: "a1", tool: "shell.run", summary: "npm install", tier: "T2" } as never });
    expect(widgetIds(container)).toEqual(["approval", "usage"]);
  });

  it("standard shows system, voice, activity, approvals and usage", () => {
    const { container } = mount({ density: "standard" });
    expect(widgetIds(container)).toEqual([...HUD_WIDGET_IDS].sort());
  });

  it("full shows all nine, and a switched-off one stays away", () => {
    const { container } = mount({ density: "full", widgets: { radar: false } });
    expect(widgetIds(container)).toHaveLength(8);
    expect(widgetIds(container)).not.toContain("radar");
  });

  it("tells the app which instrument was clicked", () => {
    const onExpand = vi.fn();
    const { container } = mount({}, {}, [1920, 1080], { onExpand });
    fireEvent.click(container.querySelector('[data-widget="system"]')!);
    expect(onExpand).toHaveBeenCalledWith({ kind: "widget", id: "system" });
  });
});

describe("the window", () => {
  it("is an orbit on a wide window and a chip row on a phone", () => {
    const wide = mount();
    expect(wide.container.querySelector(".orbital")!.getAttribute("data-mode")).toBe("orbit");
    cleanup();
    const phone = mount({}, {}, [360, 800]);
    expect(phone.container.querySelector(".orbital")!.getAttribute("data-mode")).toBe("compact");
    expect(phone.container.querySelectorAll(".ob-node")).toHaveLength(0);
    expect(phone.container.querySelectorAll(".ob-chip")).toHaveLength(3);
  });

  it("keeps the approval on a phone too", () => {
    const { container } = mount({ density: "calm" }, { approval: { id: "a1", tool: "x", summary: "y", tier: "T2" } as never }, [360, 800]);
    expect(widgetIds(container)).toContain("approval");
  });
});

describe("motion", () => {
  it("carries the owner's animation setting for the stylesheet", () => {
    const { container } = mount({ animations: "reduced" });
    expect(container.querySelector(".orbital")!.getAttribute("data-hud-anim")).toBe("reduced");
  });

  it("pauses while the tab is hidden and resumes when it is shown", () => {
    const { container } = mount();
    const root = container.querySelector(".orbital")!;
    expect(root.hasAttribute("data-paused")).toBe(false);
    Object.defineProperty(document, "hidden", { value: true, configurable: true });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(root.hasAttribute("data-paused")).toBe(true);
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    act(() => void document.dispatchEvent(new Event("visibilitychange")));
    expect(root.hasAttribute("data-paused")).toBe(false);
  });
});

describe("what the instruments show", () => {
  const waiting = { id: "a1", tool: "shell.run", summary: "Run: npm install", tier: "T2", needsPin: false } as never;

  it("puts the approval in an alert dialog, not behind a click-to-expand button", () => {
    const { container, getByRole } = mount({ density: "calm" }, { approval: waiting });
    expect(getByRole("alertdialog", { name: /approval needed/i })).toBeTruthy();
    expect(container.querySelector('[data-widget="approval"]')!.getAttribute("role")).not.toBe("button");
  });

  it("shows the conversation in the activity instrument", () => {
    const { container } = mount({ density: "standard" }, { chat: [{ role: "assistant", text: "the landing page is done" }] });
    expect(container.querySelector('[data-widget="feed"]')!.textContent).toContain("the landing page is done");
  });

  it("explains the usage figure", () => {
    const { container } = mount({ density: "calm" });
    expect(container.querySelector('[data-widget="usage"]')!.getAttribute("title")).toMatch(/busiest day/i);
  });

  it("says there are no workers yet in the tickets and budget instruments", () => {
    const { container } = mount({ density: "full" });
    expect(container.querySelector('[data-widget="tickets"]')!.textContent).toMatch(/no workers yet/i);
    expect(container.querySelector('[data-widget="budget"]')!.textContent).toMatch(/no workers yet/i);
  });

  it("shows the PC's reading in the system instrument and the real sources on the radar", () => {
    const stats = { cpu: 38, ramUsed: 8e9, ramTotal: 16e9, netDown: 0, netUp: 0, at: Date.now() };
    const { container } = mount({ density: "full" }, { stats, deviceOnline: false });
    expect(container.querySelector('[data-widget="system"]')!.textContent).toMatch(/38%/);
    expect(container.querySelector('[data-widget="radar"] [data-blip][data-dim]')!.textContent).toBe("PC");
  });
});

describe("when one piece of the screen throws", () => {
  it("drops only that piece and keeps the rest", () => {
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    const bad = { id: "bad", icon: undefined, label: undefined, action: { type: "panel", value: "chat" } } as never;
    const { container } = mount({ launcher: [bad, ...launcher], clock: { hour12: true, seconds: false, locale: "!!" } });
    expect(container.querySelectorAll(".ob-node")).toHaveLength(3);
    expect(container.querySelector('[data-widget="system"]')).toBeTruthy();
    expect(container.querySelector(".orbital")).toBeTruthy();
    err.mockRestore();
  });
});

describe("a waiting approval", () => {
  const waiting = { id: "a1", tool: "shell.run", summary: "Run: npm install", tier: "T3", needsPin: true } as never;
  const element = (state: Partial<StageViewState>, size: [number, number]) => {
    const hud = hudOf({ density: "full" });
    return <OrbitalHud hud={hud} state={{ ...initialState, connection: "open", hud, ...state }} viewport={{ w: size[0], h: size[1] }} usage={42} onLaunch={() => {}} onExpand={() => {}} />;
  };

  it("is drawn as a dialog in the middle of the screen, large enough for the PIN pad", () => {
    const { container } = render(element({ approval: waiting }, [1366, 768]));
    const f = container.querySelector<HTMLElement>('[data-widget="approval"]')!;
    expect(f.className).toContain("ob-modal");
    expect(parseFloat(f.style.width)).toBeGreaterThanOrEqual(340);
    expect(parseFloat(f.style.height)).toBeGreaterThanOrEqual(300);
  });

  it("is a dialog in the middle for every approval, with its answers inside, not a small box in the corner", () => {
    const plain = { id: "a2", tool: "office.action", summary: "Worker Ben wants to Write C:\\Users\\me\\AppData\\Local\\Temp\\friend-office-demo\\site\\hello.txt", tier: "T2", needsPin: false } as never;
    const { container } = render(element({ approval: plain }, [1366, 768]));
    const f = container.querySelector<HTMLElement>('[data-widget="approval"]')!;
    expect(f.className).toContain("ob-modal");
    expect(within(f).getByRole("button", { name: /^approve$/i })).toBeTruthy();
    expect(within(f).getByRole("button", { name: /^deny$/i })).toBeTruthy();
    expect(parseFloat(f.style.height)).toBeLessThanOrEqual(768 - 16);
    expect(container.querySelectorAll('[data-widget="approval"]')).toHaveLength(1);
  });

  it("wraps a long command instead of scrolling sideways, and says a worker's question in one line", () => {
    const css = readFileSync(join(process.cwd(), "src/hud/orbital/orbital.css"), "utf8");
    expect(css).toMatch(/\.ob-approval \.ob-summary \{[^}]*white-space: pre-wrap/);
    expect(css).toMatch(/\.ob-approval \.ob-summary \{[^}]*overflow-wrap: anywhere/);
    const plain = { id: "a2", tool: "office.action", summary: "Worker Ben wants to Write x", tier: "T2", needsPin: false } as never;
    const { container } = render(element({ approval: plain }, [1366, 768]));
    expect(container.textContent).not.toContain("office.action wants to run");
  });

  it("fills the width of a phone", () => {
    const { container } = render(element({ approval: waiting }, [360, 800]));
    const f = container.querySelector<HTMLElement>('[data-widget="approval"]')!;
    expect(f.className).toContain("ob-modal");
    expect(parseFloat(f.style.width)).toBe(344);
  });

  it("closes an instrument that is open, so nothing covers it", () => {
    const { container, rerender } = render(element({}, [1920, 1080]));
    fireEvent.click(container.querySelector('[data-widget="system"]')!);
    expect(container.querySelector(".ob-expanded")).toBeTruthy();
    rerender(element({ approval: waiting }, [1920, 1080]));
    expect(container.querySelector(".ob-expanded")).toBeNull();
    expect(container.querySelector('[data-widget="approval"]')!.className).toContain("ob-modal");
  });
});

describe("the phone layout", () => {
  it("tells the owner the status, since the corner badge is not drawn", () => {
    const { container } = mount({}, {}, [360, 800]);
    expect(container.querySelector(".ob-compact-status")!.textContent).toMatch(/ready|offline|listening|working/i);
  });

  it("lets a press through the empty parts of the strip, so the orb can still be pressed", () => {
    const { container } = mount({}, {}, [360, 800]);
    expect(container.querySelector(".ob-strip")!.classList.contains("ob-hit")).toBe(false);
    const css = readFileSync(join(process.cwd(), "src/hud/orbital/orbital.css"), "utf8");
    expect(css).toMatch(/\[data-mode="compact"\] \.ob-strip \{[^}]*pointer-events: none/);
    expect(css).toMatch(/\.ob-strip > \* \{[^}]*pointer-events: auto/);
  });
});
