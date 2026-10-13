import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from "vitest";
import { StageApp } from "./App";
import { initialState, type StageViewState } from "./store";
import { useFriend } from "./useFriend";

vi.mock("./useFriend", () => ({ useFriend: vi.fn() }));

const voice = { pressStart() {}, pressEnd() {}, blur() {}, unlock() {} };

function show(over: Partial<StageViewState>) {
  const dispatch = vi.fn();
  (useFriend as Mock).mockReturnValue({ state: { ...initialState, connection: "open", deviceOnline: true, ...over }, send: vi.fn(), dispatch, voice, handsFree: { on: false, supported: false, toggle() {} } });
  return dispatch;
}
const badge = () => screen.queryByTestId("status-badge");
const clock = () => screen.queryByTestId("clock");

beforeEach(() => {
  localStorage.clear();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({ ok: true, json: async () => [] })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("the status line and the clock", () => {
  it("are not drawn until the server has said which view the owner chose, so they never flash up and vanish", () => {
    show({ viewKnown: false, view: "companion" });
    render(<StageApp onSignedOut={() => {}} />);
    expect(badge()).toBeNull();
    expect(clock()).toBeNull();
  });

  it("are there in the default (companion) view once it is known", () => {
    show({ viewKnown: true, view: "companion" });
    render(<StageApp onSignedOut={() => {}} />);
    expect(badge()).toBeTruthy();
    expect(clock()).toBeTruthy();
  });

  it("stay when the view becomes known, rather than appearing and going away", () => {
    show({ viewKnown: false, view: "companion" });
    const { rerender } = render(<StageApp onSignedOut={() => {}} />);
    expect(badge()).toBeNull();
    show({ viewKnown: true, view: "companion" });
    rerender(<StageApp onSignedOut={() => {}} />);
    expect(badge()).toBeTruthy();
    show({ viewKnown: true, view: "companion", busy: true, activity: "Thinking" });
    rerender(<StageApp onSignedOut={() => {}} />);
    expect(badge()).toBeTruthy();
    expect(clock()).toBeTruthy();
  });

  it("are hidden in the minimal view, on purpose, and the owner is told why, once", () => {
    const dispatch = show({ viewKnown: true, view: "minimal" });
    const { rerender } = render(<StageApp onSignedOut={() => {}} />);
    expect(badge()).toBeNull();
    expect(clock()).toBeNull();
    const told = dispatch.mock.calls.filter((c) => c[0]?.type === "alert.add" && /Minimal.*status line and clock are hidden.*Esc, then View/.test(c[0].text));
    expect(told).toHaveLength(1);
    rerender(<StageApp onSignedOut={() => {}} />);
    expect(dispatch.mock.calls.filter((c) => /Minimal/.test(c[0]?.text ?? ""))).toHaveLength(1);
  });

  it("do not say anything about minimal in the other views", () => {
    const dispatch = show({ viewKnown: true, view: "workspace" });
    render(<StageApp onSignedOut={() => {}} />);
    expect(dispatch.mock.calls.some((c) => /Minimal/.test(c[0]?.text ?? ""))).toBe(false);
  });

  it("come back as soon as the owner leaves minimal", () => {
    show({ viewKnown: true, view: "minimal" });
    const { rerender } = render(<StageApp onSignedOut={() => {}} />);
    expect(badge()).toBeNull();
    show({ viewKnown: true, view: "companion" });
    rerender(<StageApp onSignedOut={() => {}} />);
    expect(badge()).toBeTruthy();
    expect(clock()).toBeTruthy();
  });
});

describe("the workspace view", () => {
  it("shows the chat and the schedule panels as well, but only once the view is known", () => {
    show({ viewKnown: false, view: "workspace" });
    const { rerender } = render(<StageApp onSignedOut={() => {}} />);
    expect(screen.queryByLabelText(/Chat panel/)).toBeNull();
    show({ viewKnown: true, view: "workspace" });
    rerender(<StageApp onSignedOut={() => {}} />);
    expect(screen.getByLabelText(/Chat panel/)).toBeTruthy();
    expect(screen.getByLabelText(/Schedule panel/)).toBeTruthy();
    expect(badge()).toBeTruthy();
  });
});
