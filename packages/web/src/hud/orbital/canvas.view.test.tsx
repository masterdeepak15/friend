import type { HudView, OfficeWorkerView } from "@friend/protocol";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, type OfficeState } from "../../store";
import { OrbitalHud } from "./OrbitalHud";

afterEach(cleanup);

const hud: HudView = { terminalLabel: "T", clock: { hour12: true, seconds: false, locale: "" }, launcher: [], animations: "full", layout: "orbital", density: "standard", widgets: {} };
const worker = (name: string, over: Partial<OfficeWorkerView> = {}): OfficeWorkerView => ({ id: name.toLowerCase(), name, roleId: "", title: "Dev", capabilities: "", managerId: null, projectId: "p", status: "idle", ticketId: null, detail: "", tokens: 0, budget: null, startedAt: null, ...over });
const office: OfficeState = { ...initialState.office, enabled: true, workers: [worker("Lena"), worker("Ben", { managerId: "lena" })] };

async function open(onWorker = vi.fn()) {
  render(<OrbitalHud hud={hud} state={{ ...initialState, connection: "open", hud, office, assistantName: "Maya" }} viewport={{ w: 1600, h: 900 }} usage={1} onLaunch={() => {}} onExpand={() => {}} {...({} as object)} />);
  fireEvent.click(screen.getByRole("button", { name: /^team/i }));
  const dialog = screen.getByRole("dialog", { name: /office team/i });
  const world = (await within(dialog).findByRole("button", { name: /^Lena,/ }, { timeout: 8000 })).closest(".ob-canvas-world") as HTMLElement;
  return { dialog, world, onWorker };
}
const scale = (el: HTMLElement) => Number(/scale\(([\d.]+)\)/.exec(el.style.transform)![1]);
const shift = (el: HTMLElement) => /translate\((-?[\d.]+)px, (-?[\d.]+)px\)/.exec(el.style.transform)!.slice(1).map(Number) as [number, number];

describe("the team canvas", () => {
  it("zooms with the wheel and with the buttons, and fits the whole team again on request", async () => {
    const { dialog, world } = await open();
    const k0 = scale(world);
    fireEvent.wheel(dialog.querySelector(".ob-canvas-room")!, { deltaY: -300, clientX: 300, clientY: 200 });
    expect(scale(world)).toBeGreaterThan(k0);
    for (let i = 0; i < 4; i++) fireEvent.click(within(dialog).getByRole("button", { name: "Zoom out" }));
    expect(scale(world)).toBeLessThan(k0);
    fireEvent.click(within(dialog).getByRole("button", { name: "Fit the team" }));
    expect(scale(world)).toBeCloseTo(k0, 5);
  }, 20_000);

  it("moves with the mouse, and can never be pushed so far that the team is lost", async () => {
    const { dialog, world } = await open();
    const [x0] = shift(world);
    const pan = dialog.querySelector(".ob-canvas-pan") as HTMLElement;
    fireEvent.pointerDown(pan, { button: 0, clientX: 100, clientY: 100, pointerId: 1 });
    fireEvent.pointerMove(pan, { clientX: 160, clientY: 130, pointerId: 1 });
    fireEvent.pointerUp(pan, { clientX: 160, clientY: 130, pointerId: 1 });
    expect(shift(world)[0]).toBeCloseTo(x0 + 60, 5);
    fireEvent.pointerDown(pan, { button: 0, clientX: 0, clientY: 0, pointerId: 1 });
    fireEvent.pointerMove(pan, { clientX: 99999, clientY: -99999, pointerId: 1 });
    fireEvent.pointerUp(pan, { clientX: 99999, clientY: -99999, pointerId: 1 });
    const [x, y] = shift(world);
    expect(x).toBeLessThan(640); // still partly inside the room
    expect(y + 140 * scale(world)).toBeGreaterThan(0);
  }, 20_000);

  it("opens a worker with a click, but not at the end of a drag", async () => {
    const { dialog } = await open();
    const pan = dialog.querySelector(".ob-canvas-pan") as HTMLElement;
    const node = within(dialog).getByRole("button", { name: /^Ben,/ });
    fireEvent.pointerDown(pan, { button: 0, clientX: 50, clientY: 50, pointerId: 1 });
    fireEvent.pointerMove(pan, { clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.pointerUp(pan, { clientX: 120, clientY: 90, pointerId: 1 });
    fireEvent.click(node); // the click that ends a drag
    expect(screen.queryByRole("dialog", { name: "Ben" })).toBeNull();
    fireEvent.pointerDown(pan, { button: 0, clientX: 10, clientY: 10, pointerId: 2 });
    fireEvent.pointerUp(pan, { clientX: 10, clientY: 10, pointerId: 2 });
    fireEvent.click(node);
    expect(screen.getByRole("dialog", { name: "Ben" })).toBeTruthy();
  }, 20_000);
});