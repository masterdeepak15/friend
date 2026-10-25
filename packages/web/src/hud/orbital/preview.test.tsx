import type { HudView } from "@friend/protocol";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, type StageViewState } from "../../store";
import { OrbitalHud } from "./OrbitalHud";

afterEach(cleanup);

const launcher: HudView["launcher"] = [{ id: "chat", label: "Chat", icon: "C", action: { type: "panel", value: "chat" } }];
const ALL_ON = { system: true, voice: true, network: true, feed: true, radar: true, tickets: true, approval: true };
const hudOf = (over: Partial<HudView> = {}): HudView => ({ terminalLabel: "T", clock: { hour12: true, seconds: false, locale: "" }, launcher, animations: "full", layout: "orbital", density: "full", widgets: ALL_ON, ...over });
const mount = (over: Partial<HudView> = {}, state: Partial<StageViewState> = {}, size: [number, number] = [1920, 1080], send = () => {}) => {
  const hud = hudOf(over);
  return render(<OrbitalHud hud={hud} state={{ ...initialState, connection: "open", hud, assistantName: "maya", ...state }} viewport={{ w: size[0], h: size[1] }} usage={null} send={send} onLaunch={() => {}} onExpand={() => {}} />);
};
const widget = (c: HTMLElement, id: string) => c.querySelector<HTMLElement>(`[data-widget="${id}"]`)!;

describe("the sample data", () => {
  it("is not there unless it is switched on", () => {
    const { container } = mount();
    expect(container.querySelector(".ob-sample-tag")).toBeNull();
    expect(container.querySelector(".ob-node-detail")).toBeNull();
    expect(widget(container, "tickets").textContent).toMatch(/no workers yet/i);
  });

  it("says plainly that it is sample data", () => {
    const { container } = mount({ preview: true });
    expect(container.querySelector(".ob-sample-tag")!.textContent).toMatch(/sample data/i);
  });

  it("fills the orbit with the mockup's workers, in its slots, with their states and what each is doing", () => {
    const { container } = mount({ preview: true });
    const nodes = [...container.querySelectorAll<HTMLElement>(".ob-node")];
    expect(nodes.map((n) => n.getAttribute("title"))).toEqual(["CODE", "TEST", "REV", "+", "ARCH"]);
    expect(nodes.map((n) => n.getAttribute("data-status"))).toEqual(["running", "running", "waiting", "add", "idle"]);
    expect(nodes.map((n) => [Math.round(parseFloat(n.style.left)), Math.round(parseFloat(n.style.top))])).toEqual([
      [800, 150],
      [1060, 300],
      [1060, 600],
      [540, 600],
      [540, 300],
    ]);
    const details = [...container.querySelectorAll(".ob-node-detail")].map((d) => d.textContent);
    expect(details).toEqual(["▶ Hero.tsx · 62%", "▶ 12/12 passing", "⏸ needs approval", "HIRE WORKER", "idle"]);
    expect(container.querySelectorAll(".ob-link[data-tone='orange']")).toHaveLength(1);
  });

  it("lights the usage ring at 42% and fills the tickets, the budget, the feed and the system readings", () => {
    const { container } = mount({ preview: true });
    expect(container.querySelectorAll("[data-seg][data-on='true']")).toHaveLength(25);
    expect(widget(container, "tickets").textContent).toMatch(/DONE 3.*DOING 3.*REVIEW 1.*TODO 4/);
    expect(widget(container, "tickets").querySelectorAll("[data-status]")).toHaveLength(11);
    expect(widget(container, "budget").textContent).toMatch(/CODE 42%.*TEST 70%.*REV 25%/);
    expect(widget(container, "feed").textContent).toMatch(/edit src\/Hero\.tsx/);
    expect(widget(container, "feed").querySelector(".ob-org")!.textContent).toMatch(/REV/);
    expect(widget(container, "system").textContent).toMatch(/38%/);
    expect(widget(container, "system").textContent).toMatch(/RAM 61%/);
    expect(widget(container, "network").textContent).toMatch(/2\.4 MB\/s/);
    expect([...widget(container, "radar").querySelectorAll("[data-blip]")].map((b) => b.textContent)).toEqual(["PC", "PHONE", "ALEXA?"]);
  });

  it("shows the approval of the mockup, and answering it does nothing", () => {
    const send = vi.fn();
    const { container, getByRole } = mount({ preview: true }, {}, [1920, 1080], send);
    expect(widget(container, "approval").textContent).toMatch(/npm install --save zod/);
    fireEvent.click(getByRole("button", { name: /approve$/i }));
    fireEvent.click(getByRole("button", { name: /deny/i }));
    expect(send).not.toHaveBeenCalled();
  });

  it("gives way to a real approval", () => {
    const send = vi.fn();
    const real = { id: "real1", tool: "shell.run", summary: "Run: dir", tier: "T2", needsPin: false } as never;
    const { container, getByRole } = mount({ preview: true }, { approval: real }, [1920, 1080], send);
    expect(widget(container, "approval").textContent).toMatch(/Run: dir/);
    expect(widget(container, "approval").textContent).not.toMatch(/zod/);
    fireEvent.click(getByRole("button", { name: /approve$/i }));
    expect(send).toHaveBeenCalledWith({ type: "approval.respond", id: "real1", decision: "approve" });
  });

  it("is only for the full screen, not the phone", () => {
    const { container } = mount({ preview: true }, {}, [360, 800]);
    expect(container.querySelector(".ob-sample-tag")).toBeNull();
  });
});
