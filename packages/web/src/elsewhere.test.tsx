import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElsewhereCard } from "./overlay/ElsewhereCard";
import { describeStatus } from "./overlay/StatusBadge";
import { createSocket } from "./socket";

class FakeWS {
  static all: FakeWS[] = [];
  static OPEN = 1;
  readyState = 1;
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(public url: string) {
    FakeWS.all.push(this);
  }
  send() {}
  close() {}
}

beforeEach(() => {
  FakeWS.all = [];
  vi.stubGlobal("WebSocket", FakeWS);
  sessionStorage.clear();
});
afterEach(() => vi.unstubAllGlobals());

describe("Friend open in another window", () => {
  it("names the tab on every connection, and keeps the same name after a reload", () => {
    createSocket("ws://x/ws").close();
    createSocket("ws://x/ws").close();
    const tabs = FakeWS.all.map((w) => new URL(w.url).searchParams.get("tab"));
    expect(tabs[0]).toBeTruthy();
    expect(tabs[1]).toBe(tabs[0]);
  });

  it("stops and says so when another window has Friend, instead of reconnecting", () => {
    vi.useFakeTimers();
    const s = createSocket("ws://x/ws");
    const states: string[] = [];
    s.onState((v) => states.push(v));
    FakeWS.all[0]!.onclose!({ code: 4409 });
    vi.advanceTimersByTime(20_000);
    expect(s.state()).toBe("elsewhere");
    expect(FakeWS.all).toHaveLength(1); // no reconnect loop
    vi.useRealTimers();
    s.close();
  });

  it("Use here reconnects asking to take over, and a later drop reconnects normally", () => {
    vi.useFakeTimers();
    const s = createSocket("ws://x/ws");
    FakeWS.all[0]!.onclose!({ code: 4410 });
    s.takeOver();
    expect(new URL(FakeWS.all[1]!.url).searchParams.get("takeover")).toBe("1");
    FakeWS.all[1]!.onopen!();
    FakeWS.all[1]!.onclose!({ code: 1006 });
    vi.advanceTimersByTime(1000);
    expect(new URL(FakeWS.all[2]!.url).searchParams.get("takeover")).toBeNull();
    vi.useRealTimers();
    s.close();
  });

  it("Use here does nothing while the window is not displaced", () => {
    const s = createSocket("ws://x/ws");
    s.takeOver();
    expect(FakeWS.all).toHaveLength(1);
    s.close();
  });

  it("shows the Use here card and the button asks to take over", () => {
    const onUseHere = vi.fn();
    render(<ElsewhereCard onUseHere={onUseHere} />);
    expect(screen.getByText(/open in another window/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Use here" }));
    expect(onUseHere).toHaveBeenCalledOnce();
  });

  it("the status line says where Friend is", () => {
    const base = { deviceOnline: true, approval: null, voiceMode: "idle", busy: false, activity: null } as never;
    expect(describeStatus({ ...(base as object), connection: "elsewhere" } as never).text).toBe("Open in another window");
  });
});
