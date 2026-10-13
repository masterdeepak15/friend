import { renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RELEASE_MS, useDuckReporting } from "./useDuckReporting";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

function setup(mode: string) {
  const send = vi.fn();
  const view = renderHook(({ m }) => useDuckReporting(m, send), { initialProps: { m: mode } });
  return { send, set: (m: string) => view.rerender({ m }), unmount: view.unmount };
}
const activity = (send: ReturnType<typeof vi.fn>) => send.mock.calls.map((c) => (c[0] as { active: boolean }).active);

describe("telling the server that someone is talking", () => {
  it("says nothing while nothing is going on", () => {
    const { send } = setup("idle");
    vi.advanceTimersByTime(5000);
    expect(send).not.toHaveBeenCalled();
  });

  it("says so at once when the owner starts listening, and when Friend starts speaking", () => {
    const a = setup("idle");
    a.set("listening");
    expect(send0(a.send)).toEqual({ type: "audio.activity", active: true });
    const b = setup("idle");
    b.set("speaking");
    expect(activity(b.send)).toEqual([true]);
  });

  it("does not say it again while it carries on, or when it goes from listening to speaking", () => {
    const { send, set } = setup("listening");
    set("transcribing");
    set("speaking");
    expect(activity(send).filter((x) => x === true)).toEqual([true]);
  });

  it("waits a moment before saying it is over, so the sound does not jump up between sentences", () => {
    const { send, set } = setup("speaking");
    set("idle");
    vi.advanceTimersByTime(RELEASE_MS - 50);
    expect(activity(send)).toEqual([true]);
    vi.advanceTimersByTime(100);
    expect(activity(send)).toEqual([true, false]);
  });

  it("stays down when it starts again inside that moment", () => {
    const { send, set } = setup("listening");
    set("transcribing");
    vi.advanceTimersByTime(RELEASE_MS - 100);
    set("speaking");
    vi.advanceTimersByTime(5000);
    expect(activity(send)).toEqual([true]);
  });

  it("lets go when the screen goes away", () => {
    const { send, unmount } = setup("speaking");
    unmount();
    expect(activity(send)).toEqual([true, false]);
  });

  it("does not let go twice", () => {
    const { send, set } = setup("listening");
    set("idle");
    vi.advanceTimersByTime(RELEASE_MS + 10);
    set("idle");
    vi.advanceTimersByTime(5000);
    expect(activity(send)).toEqual([true, false]);
  });
});

function send0(send: ReturnType<typeof vi.fn>) {
  return send.mock.calls[0]![0];
}
