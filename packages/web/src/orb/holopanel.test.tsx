import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HoloPanel } from "./HoloPanel";

afterEach(cleanup);

function setup(over: Partial<Parameters<typeof HoloPanel>[0]> = {}) {
  const fns = { prev: vi.fn(), next: vi.fn(), apply: vi.fn(), done: vi.fn(), undo: vi.fn() };
  render(
    <HoloPanel title="Voice" label="Settings" page={{ index: 1, total: 4, onPrev: fns.prev, onNext: fns.next }} help="Fill in the settings and press apply." onApply={fns.apply} onDone={fns.done} onUndo={fns.undo} {...over}>
      <p>the setting</p>
    </HoloPanel>,
  );
  return fns;
}

describe("the glass panel", () => {
  it("is a dialog with its title, its content and its help text", () => {
    setup();
    expect(screen.getByRole("dialog", { name: "Settings" })).toBeTruthy();
    expect(screen.getByRole("heading", { name: "Voice" })).toBeTruthy();
    expect(screen.getByText("the setting")).toBeTruthy();
    expect(screen.getByText(/fill in the settings/i)).toBeTruthy();
  });

  it("pages with the arrows, and shows which page it is on", async () => {
    const f = setup();
    await userEvent.click(screen.getByRole("button", { name: "Previous page" }));
    await userEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(f.prev).toHaveBeenCalledTimes(1);
    expect(f.next).toHaveBeenCalledTimes(1);
    expect(screen.getByText("Page 2 of 4")).toBeTruthy();
  });

  it("has no arrows when there is only one page", () => {
    setup({ page: undefined });
    expect(screen.queryByRole("button", { name: "Next page" })).toBeNull();
  });

  it("applies, and the apply button waits until there is something to apply", async () => {
    const f = setup({ dirty: true });
    await userEvent.click(screen.getByRole("button", { name: "Apply" }));
    expect(f.apply).toHaveBeenCalledTimes(1);
    cleanup();
    setup({ dirty: false });
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("applying can also be switched off while something is being saved", () => {
    setup({ dirty: true, busy: true });
    expect((screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("closes straight away when nothing was changed", async () => {
    const f = setup({ dirty: false });
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(f.done).toHaveBeenCalledTimes(1);
  });

  it("warns before closing with changes that were not applied, and lets the owner keep editing or discard", async () => {
    const f = setup({ dirty: true });
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(f.done).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toMatch(/not applied/i);
    await userEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    expect(screen.queryByRole("alert")).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Done" }));
    await userEvent.click(screen.getByRole("button", { name: "Discard" }));
    expect(f.done).toHaveBeenCalledTimes(1);
  });

  it("offers to undo the changes made so far", async () => {
    const f = setup({ dirty: true });
    await userEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(f.undo).toHaveBeenCalledTimes(1);
    cleanup();
    setup({ dirty: false });
    expect(screen.queryByRole("button", { name: "Undo" })).toBeNull();
  });

  it("can leave out the apply button (a page with nothing to save)", () => {
    setup({ onApply: undefined });
    expect(screen.queryByRole("button", { name: "Apply" })).toBeNull();
    expect(screen.getByRole("button", { name: "Done" })).toBeTruthy();
  });
});
