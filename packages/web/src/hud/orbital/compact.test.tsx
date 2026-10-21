import type { HudView } from "@friend/protocol";
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { initialState, type StageViewState } from "../../store";
import { OrbitalHud } from "./OrbitalHud";

afterEach(cleanup);

const launcher: HudView["launcher"] = [
  { id: "chat", label: "Chat", icon: "C", action: { type: "panel", value: "chat" } },
  { id: "music", label: "Music", icon: "M", action: { type: "panel", value: "music" } },
];
const hudOf = (over: Partial<HudView> = {}): HudView => ({ terminalLabel: "T", clock: { hour12: true, seconds: false, locale: "" }, launcher, animations: "full", layout: "orbital", density: "standard", widgets: {}, ...over });

function mount(size: [number, number], over: Partial<HudView> = {}, state: Partial<StageViewState> = {}) {
  const hud = hudOf(over);
  return render(<OrbitalHud hud={hud} state={{ ...initialState, connection: "open", hud, ...state }} viewport={{ w: size[0], h: size[1] }} usage={42} onLaunch={() => {}} onExpand={() => {}} />);
}

describe("a phone", () => {
  it("has no orbit and no ring of hexagons: the launcher is a row of chips", () => {
    const { container } = mount([360, 800]);
    expect(container.querySelector(".ob-scene")).toBeNull();
    expect(container.querySelectorAll(".ob-node")).toHaveLength(0);
    expect([...container.querySelectorAll(".ob-chip")].map((c) => c.textContent?.trim())).toEqual(["C Chat", "M Music"]);
  });

  it("keeps the instruments in a strip, the usage figure, and an approval that is waiting", () => {
    const approval = { id: "a1", tool: "x", summary: "Run it", tier: "T2", needsPin: false } as never;
    const { container } = mount([360, 800], { density: "calm" }, { approval });
    const ids = [...container.querySelectorAll("[data-widget]")].map((e) => e.getAttribute("data-widget"));
    expect(ids).toContain("approval");
    expect(ids).toContain("usage");
    expect(container.querySelector(".ob-strip")).toBeTruthy();
  });

  it("does not draw outside a narrow window", () => {
    const { container } = mount([320, 568], { density: "full" });
    expect(container.querySelector(".ob-scene")).toBeNull();
  });
});

describe("a wide window", () => {
  it("draws the orbit with its rings and a link to every node", () => {
    const { container } = mount([1920, 1080]);
    expect(container.querySelector(".ob-scene")).toBeTruthy();
    expect(container.querySelector(".ob-orbit")).toBeTruthy();
    expect(container.querySelectorAll(".ob-link")).toHaveLength(2);
    expect(container.querySelectorAll(".ob-chip")).toHaveLength(0);
  });

  it("hands the owner's animation setting to the stylesheet", () => {
    const { container } = mount([1920, 1080], { animations: "off" });
    expect(container.querySelector(".orbital")!.getAttribute("data-hud-anim")).toBe("off");
  });
});
