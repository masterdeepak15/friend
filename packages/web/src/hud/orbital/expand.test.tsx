import type { HudView } from "@friend/protocol";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UsageApi, UsageSummary } from "../../settings/UsageTab";
import { initialState } from "../../store";
import { OrbitalHud } from "./OrbitalHud";

afterEach(cleanup);

const hud: HudView = { terminalLabel: "T", clock: { hour12: true, seconds: false, locale: "" }, launcher: [], animations: "full", layout: "orbital", density: "full", widgets: {} };
const usageApi = (bySource: UsageSummary["bySource"] = []): UsageApi => ({
  summary: async () => ({ range: 30, days: [], total: { input: 0, output: 0, turns: 0 }, byModel: [], bySource }),
  clear: async () => ({ removed: 0 }),
});

function mount(extra: { usageApi?: UsageApi; wrapper?: (children: React.ReactNode) => React.ReactNode } = {}) {
  const ui = <OrbitalHud hud={hud} state={{ ...initialState, connection: "open", hud }} viewport={{ w: 1920, h: 1080 }} usage={42} usageApi={extra.usageApi ?? usageApi()} onLaunch={() => {}} onExpand={() => {}} />;
  return render(<>{extra.wrapper ? extra.wrapper(ui) : ui}</>);
}
const frame = (c: HTMLElement, id: string) => c.querySelector(`[data-widget="${id}"]`) as HTMLElement;

describe("expanding an instrument", () => {
  it("opens the instrument in the middle of the screen when it is clicked", () => {
    const { container } = mount();
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(frame(container, "system"));
    const dialog = screen.getByRole("dialog", { name: /system/i });
    expect(dialog).toBeTruthy();
    expect(dialog.textContent).toMatch(/waiting for data/i);
  });

  it("shows one at a time: the next click replaces the first", () => {
    const { container } = mount();
    fireEvent.click(frame(container, "system"));
    fireEvent.click(frame(container, "radar"));
    expect(screen.getAllByRole("dialog")).toHaveLength(1);
    expect(screen.getByRole("dialog", { name: /devices/i })).toBeTruthy();
  });

  it("opens with Enter or Space on a focused instrument", () => {
    const { container } = mount();
    const f = frame(container, "voice");
    fireEvent.keyDown(f, { key: "Enter" });
    expect(screen.getByRole("dialog", { name: /voice/i })).toBeTruthy();
    cleanup();
    const again = mount();
    fireEvent.keyDown(frame(again.container, "network"), { key: " " });
    expect(screen.getByRole("dialog", { name: /network/i })).toBeTruthy();
  });
});

describe("closing it", () => {
  it("closes on Esc and puts the focus back where it was", () => {
    const { container } = mount();
    const f = frame(container, "system");
    f.focus();
    fireEvent.click(f);
    expect(document.activeElement).not.toBe(f);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(f);
  });

  it("closes on the close mark and on a click outside it", () => {
    const { container } = mount();
    fireEvent.click(frame(container, "system"));
    fireEvent.click(screen.getByRole("button", { name: /close/i }));
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(frame(container, "system"));
    fireEvent.pointerDown(container.querySelector(".ob-backdrop")!);
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("keeps a press outside from reaching whatever is underneath (so it cannot start a recording)", () => {
    const under = vi.fn();
    const { container } = mount({ wrapper: (ui) => <div onPointerDown={under}>{ui}</div> });
    fireEvent.click(frame(container, "system"));
    fireEvent.pointerDown(container.querySelector(".ob-backdrop")!);
    expect(under).not.toHaveBeenCalled();
  });

  it("takes the Esc itself while open, and leaves it alone when nothing is open", () => {
    const other = vi.fn();
    window.addEventListener("keydown", other);
    const { container } = mount();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(other).toHaveBeenCalledTimes(1);
    fireEvent.click(frame(container, "system"));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(other).toHaveBeenCalledTimes(1);
    window.removeEventListener("keydown", other);
  });
});

describe("what each expanded instrument shows", () => {
  it("lists where the usage went, by source", async () => {
    const { container } = mount({ usageApi: usageApi([{ source: "chat", input: 1200, output: 300, turns: 4 }, { source: "voice", input: 40, output: 10, turns: 1 }]) });
    await act(async () => void fireEvent.click(frame(container, "usage")));
    await waitFor(() => expect(screen.getByRole("dialog").textContent).toMatch(/Chat/));
    expect(screen.getByRole("dialog").textContent).toMatch(/Voice/);
    expect(screen.getByRole("dialog").textContent).toMatch(/busiest day/i);
  });

  it("explains the instrument in plain words", () => {
    const { container } = mount();
    fireEvent.click(frame(container, "tickets"));
    expect(screen.getByRole("dialog").textContent).toMatch(/no workers yet/i);
  });
});
