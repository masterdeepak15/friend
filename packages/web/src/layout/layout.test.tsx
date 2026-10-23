import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OwnerMenu } from "../overlay/OwnerMenu";
import { initialState, reduce } from "../store";
import { ChatPanel } from "./ChatPanel";
import { Movable } from "./Movable";
import { VIEW_PANELS, loadPos, resetPositions, savePos, usePanels } from "./prefs";
import { TasksPanel, formatDue, type TaskItem } from "./TasksPanel";

beforeEach(() => localStorage.clear());
afterEach(cleanup);

describe("the conversation in the screen state", () => {
  const apply = (...msgs: unknown[]) => msgs.reduce<typeof initialState>((s, m) => reduce(s, m), initialState);

  it("collects what was said and the answer as it is written", () => {
    const s = apply({ type: "chat.user", text: "hello" }, { type: "caption.delta", text: "Hi " }, { type: "caption.delta", text: "there." }, { type: "caption.end" });
    expect(s.chat).toEqual([{ role: "user", text: "hello" }, { role: "assistant", text: "Hi there." }]);
    expect(s.chatLive).toBe(false);
  });

  it("starts a new answer for the next request", () => {
    const s = apply({ type: "caption.delta", text: "One." }, { type: "caption.end" }, { type: "chat.user", text: "again" }, { type: "caption.delta", text: "Two." });
    expect(s.chat.map((l) => l.text)).toEqual(["One.", "again", "Two."]);
    expect(s.chatLive).toBe(true);
  });

  it("puts earlier history in front of lines that arrived while it was loading", () => {
    const s = apply({ type: "chat.user", text: "live" }, { type: "chat.seed", lines: [{ role: "user", text: "old" }] });
    expect(s.chat.map((l) => l.text)).toEqual(["old", "live"]);
    expect(reduce(initialState, { type: "chat.seed", lines: "nonsense" }).chat).toEqual([]);
  });

  it("keeps only the newest 200 lines", () => {
    let s = initialState;
    for (let i = 0; i < 230; i++) s = reduce(s, { type: "chat.user", text: `m${i}` });
    expect(s.chat).toHaveLength(200);
    expect(s.chat.at(-1)!.text).toBe("m229");
  });

  it("takes the view from the server", () => {
    expect(initialState.view).toBe("companion");
    expect(apply({ type: "ui", view: "workspace" }).view).toBe("workspace");
    expect(apply({ type: "ui", view: "nonsense" }).view).toBe("companion");
  });
});

describe("usePanels", () => {
  type V = "minimal" | "companion" | "workspace";

  it("shows what the view says", () => {
    expect(renderHook(() => usePanels("minimal")).result.current.show).toEqual(VIEW_PANELS.minimal);
    expect(renderHook(() => usePanels("workspace")).result.current.show.chat).toBe(true);
    expect(renderHook(() => usePanels("companion")).result.current.show).toMatchObject({ chat: false, status: true, clock: true });
  });

  it("keeps the owner's own switches, also after a reload, until the view changes", () => {
    const first = renderHook(({ v }: { v: V }) => usePanels(v), { initialProps: { v: "companion" as V } });
    act(() => first.result.current.toggle("chat"));
    expect(first.result.current.show.chat).toBe(true);
    first.unmount();
    const again = renderHook(({ v }: { v: V }) => usePanels(v), { initialProps: { v: "companion" as V } });
    expect(again.result.current.show.chat).toBe(true);
    again.rerender({ v: "minimal" });
    expect(again.result.current.show.chat).toBe(false); // a new view starts from its own set
    again.rerender({ v: "workspace" });
    expect(again.result.current.show.chat).toBe(true);
    act(() => again.result.current.toggle("tasks", false));
    expect(again.result.current.show.tasks).toBe(false);
  });

  it("works when the browser will not store anything", () => {
    const set = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const get = vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new Error("blocked");
    });
    const r = renderHook(() => usePanels("companion"));
    act(() => r.result.current.toggle("chat"));
    expect(r.result.current.show.chat).toBe(true);
    set.mockRestore();
    get.mockRestore();
  });
});

describe("<Movable>", () => {
  const box = () => screen.getByTestId("w");
  const rect = { left: 100, top: 100, width: 100, height: 40, right: 200, bottom: 140, x: 100, y: 100, toJSON: () => ({}) } as DOMRect;
  beforeEach(() => {
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(() => rect);
    Object.defineProperty(window, "innerWidth", { value: 1000, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: 500, configurable: true });
    HTMLElement.prototype.setPointerCapture = () => {};
  });
  afterEach(() => vi.restoreAllMocks());

  it("starts where its style puts it", () => {
    render(
      <Movable id="clock" label="Clock" wholeBox testId="w" style={{ left: "10%", top: "20%" }}>
        x
      </Movable>,
    );
    expect(box().style.left).toBe("10%");
  });

  it("follows a drag and remembers where it was dropped", () => {
    render(
      <Movable id="clock" label="Clock" wholeBox testId="w">
        x
      </Movable>,
    );
    fireEvent.pointerDown(box(), { pointerId: 1, clientX: 110, clientY: 110, button: 0 });
    fireEvent.pointerMove(box(), { pointerId: 1, clientX: 410, clientY: 210 });
    expect(box().style.left).toBe("40%"); // the box keeps the same grip point under the pointer
    expect(box().style.top).toBe("40%");
    fireEvent.pointerUp(box(), { pointerId: 1 });
    expect(loadPos("clock")).not.toBeNull();
  });

  it("stays on the screen", () => {
    render(
      <Movable id="clock" label="Clock" wholeBox testId="w">
        x
      </Movable>,
    );
    fireEvent.pointerDown(box(), { pointerId: 1, clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(box(), { pointerId: 1, clientX: 5000, clientY: -300 });
    expect(Number.parseFloat(box().style.left)).toBeLessThanOrEqual(95);
    expect(Number.parseFloat(box().style.top)).toBeGreaterThanOrEqual(0);
  });

  it("is moved by the arrow keys, and goes back with a double click", async () => {
    render(
      <Movable id="clock" label="Clock" wholeBox testId="w">
        x
      </Movable>,
    );
    box().focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(box().style.left).toBe("12%");
    await userEvent.dblClick(box());
    expect(box().style.left).toBe("");
    expect(loadPos("clock")).toBeNull();
  });

  it("only the title bar drags a panel, not its contents", () => {
    render(
      <Movable id="chat" label="Chat" testId="w" head={<span>Title</span>}>
        <button>inside</button>
      </Movable>,
    );
    fireEvent.pointerDown(screen.getByText("inside"), { pointerId: 1, clientX: 110, clientY: 110, button: 0 });
    fireEvent.pointerMove(screen.getByText("inside"), { pointerId: 1, clientX: 400, clientY: 200 });
    expect(box().style.left).toBe("");
    fireEvent.pointerDown(screen.getByText("Title"), { pointerId: 1, clientX: 110, clientY: 110, button: 0 });
    fireEvent.pointerMove(screen.getByText("Title"), { pointerId: 1, clientX: 400, clientY: 200 });
    expect(box().style.left).not.toBe("");
  });

  it("uses a saved place and ignores a broken one", () => {
    savePos("clock", { x: 40, y: 50 });
    render(
      <Movable id="clock" label="Clock" wholeBox testId="w">
        x
      </Movable>,
    );
    expect(box().style.left).toBe("40%");
    cleanup();
    localStorage.setItem("friend.pos.clock", "{nonsense");
    render(
      <Movable id="clock" label="Clock" wholeBox testId="w">
        x
      </Movable>,
    );
    expect(box().style.left).toBe("");
    resetPositions();
  });
});

describe("<ChatPanel> and Space", () => {
  it("lets Space talk while its box is empty, like the message strip, so an open chat does not take the key", () => {
    render(<ChatPanel lines={[]} live={false} onSend={() => {}} onClose={() => {}} />);
    expect(screen.getByLabelText("Type to chat").hasAttribute("data-space-talks")).toBe(true);
  });
});

describe("<ChatPanel>", () => {
  it("shows the conversation and sends what is typed", async () => {
    const onSend = vi.fn();
    render(
      <ChatPanel
        lines={[
          { role: "user", text: "hello" },
          { role: "assistant", text: "hi there" },
        ]}
        live={false}
        onSend={onSend}
        onClose={() => {}}
      />,
    );
    expect(screen.getByText("hello").className).toContain("chat-user");
    expect(screen.getByText("hi there").className).toContain("chat-assistant");
    await userEvent.type(screen.getByLabelText("Type to chat"), "what time is it{Enter}");
    expect(onSend).toHaveBeenCalledWith("what time is it");
    expect((screen.getByLabelText("Type to chat") as HTMLInputElement).value).toBe("");
  });

  it("does not send an empty message, says when nothing was said yet, and closes", async () => {
    const onSend = vi.fn();
    const onClose = vi.fn();
    render(<ChatPanel lines={[]} live={false} onSend={onSend} onClose={onClose} />);
    expect(screen.getByText(/nothing said yet/i)).toBeTruthy();
    await userEvent.type(screen.getByLabelText("Type to chat"), "   {Enter}");
    expect(onSend).not.toHaveBeenCalled();
    await userEvent.click(screen.getByLabelText("Close chat"));
    expect(onClose).toHaveBeenCalled();
  });

  it("shows text as text, never as markup", () => {
    render(<ChatPanel lines={[{ role: "assistant", text: "<img src=x onerror=alert(1)>" }]} live={false} onSend={() => {}} onClose={() => {}} />);
    expect(document.querySelector("img")).toBeNull();
  });
});

describe("formatDue", () => {
  const now = new Date(2026, 9, 8, 12, 0).getTime();
  it("speaks plainly about when something is due", () => {
    expect(formatDue(null, now)).toEqual({ text: "to do", overdue: false });
    expect(formatDue(now - 1000, now)).toEqual({ text: "overdue", overdue: true });
    expect(formatDue(now + 20_000, now).text).toBe("now");
    expect(formatDue(now + 25 * 60_000, now).text).toBe("in 25 min");
    expect(formatDue(new Date(2026, 9, 8, 17, 0).getTime(), now).text).toMatch(/^today /);
    expect(formatDue(new Date(2026, 9, 9, 9, 0).getTime(), now).text).toMatch(/^tomorrow /);
    expect(formatDue(new Date(2026, 9, 12, 9, 0).getTime(), now).text).toMatch(/Oct/);
  });
});

describe("<TasksPanel>", () => {
  const now = () => new Date(2026, 9, 8, 12, 0).getTime();
  const items: TaskItem[] = [
    { id: 1, title: "call the bank", dueAt: now() + 30 * 60_000, repeat: null },
    { id: 2, title: "stand-up", dueAt: now() - 60_000, repeat: "daily" },
    { id: 3, title: "buy milk", dueAt: null, repeat: null },
  ];

  it("lists the tasks with when they are due, and marks the late ones", async () => {
    render(<TasksPanel source={{ list: async () => items }} busy={false} onClose={() => {}} now={now} />);
    expect(await screen.findByText("call the bank")).toBeTruthy();
    expect(screen.getByText("in 30 min")).toBeTruthy();
    expect(screen.getByText(/overdue · daily/)).toBeTruthy();
    expect(screen.getByText("to do")).toBeTruthy();
    expect(screen.getByText("stand-up").closest("li")!.className).toBe("overdue");
  });

  it("says when nothing is scheduled, and shows a failure", async () => {
    const { rerender } = render(<TasksPanel source={{ list: async () => [] }} busy={false} onClose={() => {}} now={now} />);
    expect(await screen.findByText(/nothing scheduled/i)).toBeTruthy();
    const failing = {
      list: async (): Promise<TaskItem[]> => {
        throw new Error("Please sign in again.");
      },
    };
    rerender(<TasksPanel source={failing} busy={false} onClose={() => {}} now={now} />);
    expect((await screen.findByRole("alert")).textContent).toMatch(/sign in/i);
  });

  it("looks again when a request finishes, since it may have added a task", async () => {
    const list = vi.fn(async () => items);
    const source = { list };
    const { rerender } = render(<TasksPanel source={source} busy onClose={() => {}} now={now} />);
    await waitFor(() => expect(list).toHaveBeenCalledTimes(1));
    rerender(<TasksPanel source={source} busy={false} onClose={() => {}} now={now} />);
    await waitFor(() => expect(list.mock.calls.length).toBeGreaterThan(1));
  });
});

describe("owner menu: panels and view", () => {
  it("toggles chat and schedule and cycles the view", async () => {
    const onToggleChat = vi.fn();
    const onToggleTasks = vi.fn();
    const onView = vi.fn();
    render(
      <OwnerMenu
        muted={false}
        onToggleMute={() => {}}
        onSignedOut={() => {}}
        chatOn={false}
        onToggleChat={onToggleChat}
        tasksOn
        onToggleTasks={onToggleTasks}
        view="companion"
        onView={onView}
      />,
    );
    await userEvent.keyboard("{Escape}");
    await userEvent.click(screen.getByRole("button", { name: "Chat: off" }));
    await userEvent.click(screen.getByRole("button", { name: "Schedule: on" }));
    await userEvent.click(screen.getByRole("button", { name: "View: companion" }));
    expect(onToggleChat).toHaveBeenCalled();
    expect(onToggleTasks).toHaveBeenCalled();
    expect(onView).toHaveBeenCalledWith("workspace");
  });
});
