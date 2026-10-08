import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandBar } from "../input/CommandBar";
import { PinPad } from "./PinPad";

afterEach(cleanup);

function Host({ onSubmit = () => {} }: { onSubmit?: () => void }) {
  const [pin, setPin] = useState("");
  return <PinPad pin={pin} onChange={setPin} onSubmit={onSubmit} />;
}
const dots = () => screen.getByTestId("pin-dots").textContent;

describe("PIN entry with the keyboard", () => {
  it("takes digits and Backspace without clicking", async () => {
    render(<Host />);
    await userEvent.keyboard("123456");
    expect(dots()).toBe("••••••");
    await userEvent.keyboard("{Backspace}{Backspace}");
    expect(dots()).toBe("••••");
  });

  it("ignores letters, and keys with Ctrl or Alt", async () => {
    render(<Host />);
    await userEvent.keyboard("ab{Control>}1{/Control}");
    expect(dots()).toBe("");
  });

  it("stops at twelve digits", async () => {
    render(<Host />);
    await userEvent.keyboard("12345678901234");
    expect(dots()).toBe("•".repeat(12));
  });

  it("submits on Enter only once the PIN is long enough", async () => {
    const onSubmit = vi.fn();
    render(<Host onSubmit={onSubmit} />);
    await userEvent.keyboard("123{Enter}");
    expect(onSubmit).not.toHaveBeenCalled();
    await userEvent.keyboard("456{Enter}");
    expect(onSubmit).toHaveBeenCalledTimes(1);
  });

  it("does not take digits typed into a text box", async () => {
    render(
      <>
        <input aria-label="other" />
        <Host />
      </>,
    );
    await userEvent.type(screen.getByLabelText("other"), "1234");
    expect(dots()).toBe("");
  });

  it("still works with the on-screen keys", async () => {
    render(<Host />);
    await userEvent.click(screen.getByRole("button", { name: "7" }));
    await userEvent.click(screen.getByRole("button", { name: "Backspace" }));
    await userEvent.click(screen.getByRole("button", { name: "4" }));
    expect(dots()).toBe("•");
  });

  it("keeps the digits from opening the message bar behind it", async () => {
    const onSend = vi.fn();
    render(
      <>
        <CommandBar onSend={onSend} requestOpen={0} />
        <Host />
      </>,
    );
    await userEvent.keyboard("123456");
    expect(dots()).toBe("••••••");
    expect(screen.queryByLabelText("Message")).toBeNull();
  });

  it("stops listening when the pad goes away", async () => {
    const { unmount } = render(<Host />);
    unmount();
    render(<CommandBar onSend={() => {}} requestOpen={0} />);
    await userEvent.keyboard("5");
    expect(screen.getByLabelText("Message")).toBeTruthy(); // typing opens the bar again
  });
});
