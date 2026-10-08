import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState, reduce } from "../store";
import { Clock } from "./Clock";
import { StatusBadge, describeStatus, type StatusInput } from "./StatusBadge";

const base: StatusInput = { connection: "open", deviceOnline: true, approval: null, voiceMode: "idle", busy: false, activity: null };
const approval = { id: "a", tool: "shell.run", summary: "x", tier: "T2" as const, needsPin: false };

describe("what the corner badge says", () => {
  it("is calm and ready when nothing is happening", () => {
    expect(describeStatus(base)).toEqual({ kind: "idle", text: "Ready" });
    expect(describeStatus({ ...base, deviceOnline: false }).text).toMatch(/no device/i);
  });

  it("names the work in plain words", () => {
    expect(describeStatus({ ...base, busy: true })).toEqual({ kind: "working", text: "Thinking…" });
    expect(describeStatus({ ...base, busy: true, activity: "Creating a view" }).text).toBe("Creating a view…");
    expect(describeStatus({ ...base, busy: true, activity: "Answering" }).kind).toBe("speaking");
  });

  it("shows listening, understanding and speaking", () => {
    expect(describeStatus({ ...base, voiceMode: "listening" }).text).toBe("Listening");
    expect(describeStatus({ ...base, voiceMode: "transcribing" }).text).toMatch(/understanding/i);
    expect(describeStatus({ ...base, voiceMode: "speaking" }).text).toBe("Speaking");
  });

  it("puts what needs the owner, and what is broken, ahead of everything else", () => {
    expect(describeStatus({ ...base, busy: true, activity: "Running a command", approval }).text).toMatch(/approval/i);
    expect(describeStatus({ ...base, busy: true, approval, connection: "closed" }).text).toBe("Reconnecting…");
    expect(describeStatus({ ...base, connection: "unauthorized" }).text).toBe("Signed out");
  });

  it("renders as a status region", () => {
    render(<StatusBadge {...base} busy activity="Getting the weather for Pune" />);
    expect(screen.getByRole("status").textContent).toContain("Getting the weather for Pune…");
  });
});

describe("activity in the screen state", () => {
  it("follows the server's activity messages and clears when the request ends", () => {
    let s = reduce(initialState, { type: "status", busy: true, deviceOnline: true });
    s = reduce(s, { type: "activity", text: "Creating a view" });
    expect(s.activity).toBe("Creating a view");
    s = reduce(s, { type: "activity", text: null });
    expect(s.activity).toBeNull();
    s = reduce(reduce(s, { type: "activity", text: "Thinking" }), { type: "status", busy: false, deviceOnline: true });
    expect(s.activity).toBeNull();
  });
});

describe("the clock", () => {
  it("shows the time and the date", () => {
    render(<Clock now={() => new Date(2026, 9, 8, 14, 5)} />);
    const text = screen.getByTestId("clock").textContent ?? "";
    expect(text).toMatch(/\d{1,2}[:.]05/);
    expect(text).toMatch(/Oct/);
  });
});
