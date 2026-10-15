import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OwnerMenu } from "./OwnerMenu";

afterEach(cleanup);

const open = () => fireEvent.keyDown(window, { key: "Escape" });

describe("the voice switch in the classic menu", () => {
  it("says the voice is on and turns it off with a press", () => {
    const onToggleQuiet = vi.fn();
    render(<OwnerMenu muted={false} onToggleMute={() => {}} quiet={false} onToggleQuiet={onToggleQuiet} onSignedOut={() => {}} />);
    open();
    fireEvent.click(screen.getByRole("button", { name: "Voice: on" }));
    expect(onToggleQuiet).toHaveBeenCalledTimes(1);
  });

  it("says the voice is off while it is kept off", () => {
    render(<OwnerMenu muted={false} onToggleMute={() => {}} quiet onToggleQuiet={() => {}} onSignedOut={() => {}} />);
    open();
    expect(screen.getByRole("button", { name: "Voice: off" })).toBeTruthy();
  });

  it("is not drawn where nothing can turn the voice off", () => {
    render(<OwnerMenu muted={false} onToggleMute={() => {}} onSignedOut={() => {}} />);
    open();
    expect(screen.queryByRole("button", { name: /^Voice:/ })).toBeNull();
  });
});