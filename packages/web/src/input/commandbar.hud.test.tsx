import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CommandBar } from "./CommandBar";

afterEach(cleanup);

const hud = { name: "maya", style: { left: 100, top: 200, width: 300, height: 30 } };
const box = () => screen.getByRole("textbox", { name: /message/i }) as HTMLInputElement;

describe("the message bar inside the orbital screen", () => {
  it("is always there, in the mockup's place and words, with no tap needed", () => {
    render(<CommandBar onSend={() => {}} requestOpen={0} hud={hud} />);
    const form = box().closest("form")!;
    expect(box().placeholder).toBe("▸ ask maya anything…");
    expect(form.className).toContain("command-bar-hud");
    expect([form.style.left, form.style.top, form.style.width, form.style.height]).toEqual(["100px", "200px", "300px", "30px"]);
  });

  it("sends on Enter, empties the box and stays where it is, so the view does not change", () => {
    const onSend = vi.fn();
    render(<CommandBar onSend={onSend} requestOpen={0} hud={hud} />);
    fireEvent.change(box(), { target: { value: "hello there" } });
    fireEvent.submit(box().closest("form")!);
    expect(onSend).toHaveBeenCalledWith("hello there");
    expect(box().value).toBe("");
    expect(box().closest("form")).toBeTruthy();
  });

  it("clears on Esc and stays", () => {
    render(<CommandBar onSend={() => {}} requestOpen={0} hud={hud} />);
    fireEvent.change(box(), { target: { value: "oops" } });
    fireEvent.keyDown(box(), { key: "Escape" });
    expect(box().value).toBe("");
  });

  it("takes a key typed anywhere, and a tap on the stage, into the box", () => {
    const { rerender } = render(<CommandBar onSend={() => {}} requestOpen={0} hud={hud} />);
    fireEvent.keyDown(window, { key: "h" });
    expect(box().value).toBe("h");
    expect(document.activeElement).toBe(box());
    (document.activeElement as HTMLElement).blur();
    rerender(<CommandBar onSend={() => {}} requestOpen={1} hud={hud} />);
    expect(document.activeElement).toBe(box());
  });

  it("never tells the stage it is open, so the touch buttons stay", () => {
    const onOpenChange = vi.fn();
    render(<CommandBar onSend={() => {}} requestOpen={1} hud={hud} onOpenChange={onOpenChange} />);
    expect(onOpenChange).not.toHaveBeenCalledWith(true);
  });

  it("still runs / commands without sending them to the assistant", () => {
    const run = vi.fn();
    const onSend = vi.fn();
    render(<CommandBar onSend={onSend} requestOpen={0} hud={hud} slash={{ commands: [{ name: "help", description: "List the commands", run: () => {} } as never], run }} />);
    fireEvent.change(box(), { target: { value: "/he" } });
    expect(screen.getByRole("option")).toBeTruthy();
    fireEvent.submit(box().closest("form")!);
    expect(run).toHaveBeenCalledWith("/help");
    expect(onSend).not.toHaveBeenCalled();
  });

  it("is hidden until a tap, as before, when there is no orbital screen", () => {
    render(<CommandBar onSend={() => {}} requestOpen={0} />);
    expect(screen.queryByRole("textbox")).toBeNull();
  });

  it("leaves Space for talking: it neither types into the box nor takes the focus, held or repeated", () => {
    render(<CommandBar onSend={() => {}} requestOpen={0} hud={hud} />);
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    fireEvent.keyDown(window, { key: " ", code: "Space", repeat: true });
    fireEvent.keyDown(window, { key: " ", code: "Space", repeat: true });
    expect(box().value).toBe("");
    expect(document.activeElement).not.toBe(box());
  });

  it("types a space only once the owner has put the cursor in the box", () => {
    render(<CommandBar onSend={() => {}} requestOpen={0} hud={hud} />);
    box().focus();
    fireEvent.change(box(), { target: { value: "hello world" } });
    expect(box().value).toBe("hello world");
  });

  it("stops holding the focus after sending, so Space talks again", () => {
    render(<CommandBar onSend={() => {}} requestOpen={0} hud={hud} />);
    box().focus();
    fireEvent.change(box(), { target: { value: "hi" } });
    fireEvent.submit(box().closest("form")!);
    expect(document.activeElement).not.toBe(box());
  });

  it("also leaves Space alone in the ordinary hidden bar", () => {
    render(<CommandBar onSend={() => {}} requestOpen={0} />);
    fireEvent.keyDown(window, { key: " ", code: "Space" });
    expect(screen.queryByRole("textbox")).toBeNull();
  });
});
