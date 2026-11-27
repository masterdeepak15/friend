import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MeetingsPanel } from "./MeetingsPanel";
import type { MeetingView, MeetingsApi } from "./meetingsApi";

afterEach(cleanup);

const m = (over: Partial<MeetingView> = {}): MeetingView => ({ id: 1, title: "Weekly sync", status: "ended", detail: "", startsAt: 0, startedAt: 1_700_000_000_000, endedAt: 0, host: "teams.live.com", summary: "They planned the release.", decisions: ["Ship Friday"], tasks: [{ what: "Send the notes", who: "Ann", due: "Mon" }], lines: 40, ...over });
const api = (list: MeetingView[]): MeetingsApi & { leave: ReturnType<typeof vi.fn>; remove: ReturnType<typeof vi.fn> } => ({ list: vi.fn(async () => list), leave: vi.fn(async () => "Left the meeting."), remove: vi.fn(async () => {}) });

describe("the meetings list", () => {
  it("says there is nothing yet and how to start one", async () => {
    render(<MeetingsPanel api={api([])} />);
    expect(await screen.findByText("No meetings yet.")).toBeTruthy();
    expect(screen.getByText(/join this meeting/i)).toBeTruthy();
  });

  it("shows the notes of a finished meeting, its decisions and tasks", async () => {
    render(<MeetingsPanel api={api([m()])} />);
    await userEvent.click(await screen.findByRole("button", { name: "Notes" }));
    expect(screen.getByText("They planned the release.")).toBeTruthy();
    expect(screen.getByText("Ship Friday")).toBeTruthy();
    expect(screen.getByText("Send the notes (Ann) by Mon")).toBeTruthy();
  });

  it("lets the owner make it leave a live meeting, and only delete one that is over", async () => {
    const a = api([m({ id: 2, status: "live", summary: "" }), m({ id: 3 })]);
    render(<MeetingsPanel api={a} />);
    await userEvent.click(await screen.findByRole("button", { name: "Leave" }));
    expect(a.leave).toHaveBeenCalledWith(2);
    expect(await screen.findByText("Left the meeting.")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Delete" })).toHaveLength(1);
    await userEvent.click(screen.getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(a.remove).toHaveBeenCalledWith(3));
  });

  it("shows why a meeting could not be joined", async () => {
    render(<MeetingsPanel api={api([m({ status: "failed", detail: "Nobody let it in from the lobby.", summary: "", lines: 0 })])} />);
    expect(await screen.findByText("Nobody let it in from the lobby.")).toBeTruthy();
    expect(screen.getByText(/could not join/)).toBeTruthy();
  });
});
