import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerMenu } from "./OwnerMenu";

afterEach(cleanup);
const open = () => userEvent.keyboard("{Escape}");
const base = { muted: false, onToggleMute: () => {}, onSignedOut: () => {} };

describe("<OwnerMenu> hands-free switch", () => {
  it("shows whether this device is listening for the name, and the name to say", async () => {
    const toggle = vi.fn();
    render(<OwnerMenu {...base} voiceAvailable handsFreeOn={false} onToggleHandsFree={toggle} assistantName="Maya" />);
    await open();
    const button = screen.getByRole("button", { name: "Hands-free: off" });
    expect(button.getAttribute("title")).toBe('Say "Hey Maya" and then your request');
    await userEvent.click(button);
    expect(toggle).toHaveBeenCalledTimes(1);
  });

  it("shows it when on", async () => {
    render(<OwnerMenu {...base} voiceAvailable handsFreeOn onToggleHandsFree={() => {}} />);
    await open();
    expect(screen.getByRole("button", { name: "Hands-free: on" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("is not offered when speech is unavailable or the browser cannot listen", async () => {
    render(<OwnerMenu {...base} voiceAvailable={false} onToggleHandsFree={() => {}} />);
    await open();
    expect(screen.queryByRole("button", { name: /hands-free/i })).toBeNull();
    cleanup();
    render(<OwnerMenu {...base} voiceAvailable />);
    await open();
    expect(screen.queryByRole("button", { name: /hands-free/i })).toBeNull();
  });
});
