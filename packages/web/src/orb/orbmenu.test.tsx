import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OrbMenu, type OrbMenuProps } from "./OrbMenu";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function setup(over: Partial<OrbMenuProps> = {}) {
  const calls = { mute: vi.fn(), hands: vi.fn(), settings: vi.fn(), plugins: vi.fn(), signedOut: vi.fn(), classic: vi.fn(), camera: vi.fn(), quiet: vi.fn() };
  const props: OrbMenuProps = {
    muted: false,
    onToggleMute: calls.mute,
    quiet: false,
    onToggleQuiet: calls.quiet,
    onSignedOut: calls.signedOut,
    voiceAvailable: true,
    voiceEnrolled: false,
    onEnroll: () => {},
    handsFreeOn: false,
    onToggleHandsFree: calls.hands,
    onToggleCamera: calls.camera,
    cameraOn: false,
    onSettings: calls.settings,
    onPlugins: calls.plugins,
    assistantName: "Maya",
    onClassic: calls.classic,
    ...over,
  };
  render(<OrbMenu {...props} />);
  return calls;
}
const dialog = () => screen.queryByRole("dialog", { name: "Menu" });
const arc = (name: string) => within(dialog()!).getByRole("button", { name });
const caption = () => dialog()!.querySelector(".orb-caption")!.textContent;
const esc = () => userEvent.keyboard("{Escape}");

beforeEach(() => {
  vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({}) })));
});

describe("the orb menu", () => {
  it("is not on screen until Esc, and Esc opens it with the assistant's name in the orb", async () => {
    setup();
    expect(dialog()).toBeNull();
    await esc();
    expect(dialog()).toBeTruthy();
    expect(dialog()!.querySelector(".orb-name")!.textContent).toBe("MAYA");
    expect(caption()).toBe("SELECT");
  });

  it("shows the rings of what Friend can do", async () => {
    setup();
    await esc();
    for (const name of ["Voice", "Screen", "Settings", "Connect", "Account"]) expect(arc(name)).toBeTruthy();
  });

  it("puts the name of what is under the pointer in the middle", async () => {
    setup();
    await esc();
    fireEvent.pointerEnter(arc("Settings"));
    expect(caption()).toBe("SETTINGS");
    fireEvent.pointerLeave(arc("Settings"));
    expect(caption()).toBe("SELECT");
  });

  it("fans out the items of a ring when it is clicked, and folds them back when it is clicked again", async () => {
    setup();
    await esc();
    expect(within(dialog()!).queryByRole("button", { name: "Hands-free" })).toBeNull();
    await userEvent.click(arc("Voice"));
    expect(arc("Hands-free")).toBeTruthy();
    expect(arc("Mute stage")).toBeTruthy();
    expect(arc("Voice").getAttribute("aria-expanded")).toBe("true");
    await userEvent.click(arc("Voice"));
    expect(within(dialog()!).queryByRole("button", { name: "Hands-free" })).toBeNull();
  });

  it("keeps the menu open after a switch, and shows its new state", async () => {
    const c = setup();
    await esc();
    await userEvent.click(arc("Voice"));
    expect(arc("Hands-free").getAttribute("aria-pressed")).toBe("false");
    await userEvent.click(arc("Hands-free"));
    expect(c.hands).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeTruthy();
  });

  it("shows a switch that is on", async () => {
    setup({ handsFreeOn: true });
    await esc();
    await userEvent.click(arc("Voice"));
    expect(arc("Hands-free").getAttribute("aria-pressed")).toBe("true");
  });

  it("opens a settings page on the tab that was chosen, and closes", async () => {
    const c = setup();
    await esc();
    await userEvent.click(arc("Settings"));
    await userEvent.click(arc("Voice presence"));
    expect(c.settings).toHaveBeenCalledWith("look");
    expect(dialog()).toBeNull();
  });

  it("Esc steps back from an opened ring, then closes", async () => {
    setup();
    await esc();
    await userEvent.click(arc("Settings"));
    await esc();
    expect(dialog()).toBeTruthy();
    expect(within(dialog()!).queryByRole("button", { name: "Model" })).toBeNull();
    await esc();
    expect(dialog()).toBeNull();
  });

  it("closes when the orb is clicked, or when the empty space around it is", async () => {
    setup();
    await esc();
    await userEvent.click(within(dialog()!).getByRole("button", { name: "Close the menu" }));
    expect(dialog()).toBeNull();
    await esc();
    fireEvent.pointerDown(dialog()!.querySelector(".orb-backdrop")!);
    expect(dialog()).toBeNull();
  });

  it("works from the keyboard: Tab to an arc, Enter opens it, arrows move along the ring", async () => {
    setup();
    await esc();
    arc("Voice").focus();
    await userEvent.keyboard("{Enter}");
    expect(arc("Mute stage")).toBeTruthy();
    expect(caption()).toBe("VOICE");
    arc("Voice").focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(document.activeElement).toBe(arc("Screen"));
    await userEvent.keyboard("{ArrowLeft}");
    expect(document.activeElement).toBe(arc("Voice"));
  });

  it("opens by pressing and holding the top-left corner", async () => {
    vi.useFakeTimers();
    setup();
    const hotspot = screen.getByTestId("owner-hotspot");
    fireEvent.pointerDown(hotspot);
    act(() => void vi.advanceTimersByTime(300));
    expect(dialog()).toBeNull();
    act(() => void vi.advanceTimersByTime(400));
    expect(dialog()).toBeTruthy();
  });

  it("opens when asked to from outside", () => {
    setup({ openRequest: 1 });
    expect(dialog()).toBeTruthy();
  });

  it("signs out through the same call as the classic menu", async () => {
    const c = setup();
    await esc();
    await userEvent.click(arc("Account"));
    await userEvent.click(arc("Log out"));
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("/api/logout");
    await vi.waitFor(() => expect(c.signedOut).toHaveBeenCalled());
  });

  it("locks through the emergency call, and shows that it is the dangerous one", async () => {
    const c = setup();
    await esc();
    await userEvent.click(arc("Account"));
    expect(arc("Emergency lock").classList.contains("is-danger")).toBe(true);
    await userEvent.click(arc("Emergency lock"));
    expect((fetch as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBe("/api/lock");
    await vi.waitFor(() => expect(c.signedOut).toHaveBeenCalled());
  });

  it("goes back to the classic menu when asked", async () => {
    const c = setup();
    await esc();
    await userEvent.click(arc("Account"));
    await userEvent.click(arc("Classic menu"));
    expect(c.classic).toHaveBeenCalledTimes(1);
    expect(dialog()).toBeNull();
  });

  it("does not let the page see the Enter or Space that was meant for an arc", async () => {
    setup();
    await esc();
    const seen = vi.fn();
    window.addEventListener("keydown", seen);
    arc("Voice").focus();
    await userEvent.keyboard(" ");
    window.removeEventListener("keydown", seen);
    expect(seen).not.toHaveBeenCalled();
  });
});

describe("the voice switch in the orb menu", () => {
  it("shows Speak aloud as on, and a press asks to turn it off", async () => {
    const calls = setup();
    await esc();
    await userEvent.click(arc("Voice"));
    await userEvent.click(arc("Speak aloud"));
    expect(calls.quiet).toHaveBeenCalledTimes(1);
  });

  it("shows Speak aloud as off while the voice is kept off", async () => {
    setup({ quiet: true });
    await esc();
    await userEvent.click(arc("Voice"));
    expect(arc("Speak aloud").getAttribute("aria-pressed")).toBe("false");
  });
});
