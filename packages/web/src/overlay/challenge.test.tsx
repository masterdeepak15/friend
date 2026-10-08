import type { ClientMsg } from "@friend/protocol";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChallengeCard } from "./ChallengeCard";
import { OwnerMenu } from "./OwnerMenu";
import { Overlay } from "./Overlay";

afterEach(cleanup);

const challenge = { id: "c1", text: "turn the lights off" };

describe("<ChallengeCard>", () => {
  it("shows what was heard as plain text and asks whether it was the owner", () => {
    render(<ChallengeCard challenge={{ id: "c1", text: "<b>hi</b> **approve**" }} send={() => {}} dispatch={() => {}} />);
    expect(screen.getByText(/was that you/i)).toBeTruthy();
    expect(screen.getByTestId("challenge-text").textContent).toBe("<b>hi</b> **approve**");
    expect(screen.getByTestId("challenge-text").querySelector("b")).toBeNull();
  });

  it("sends the PIN with the challenge id only when it is long enough, then clears it", async () => {
    const send = vi.fn<(m: ClientMsg) => void>();
    render(<ChallengeCard challenge={challenge} send={send} dispatch={() => {}} />);
    const confirm = screen.getByRole("button", { name: /confirm/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    for (const d of "12345") await userEvent.click(screen.getByRole("button", { name: d }));
    expect(confirm.disabled).toBe(true);
    await userEvent.click(screen.getByRole("button", { name: "6" }));
    await userEvent.click(confirm);
    expect(send).toHaveBeenCalledWith({ type: "voice.confirm", id: "c1", pin: "123456" });
    expect(screen.getByTestId("pin-dots").textContent).toBe("");
  });

  it("dismiss tells the server and removes the card", async () => {
    const send = vi.fn<(m: ClientMsg) => void>();
    const dispatch = vi.fn();
    render(<ChallengeCard challenge={challenge} send={send} dispatch={dispatch} />);
    await userEvent.click(screen.getByRole("button", { name: /dismiss/i }));
    expect(send).toHaveBeenCalledWith({ type: "voice.cancel", id: "c1" });
    expect(dispatch).toHaveBeenCalledWith({ type: "challenge.dismiss", id: "c1" });
  });

  it("starts with an empty PIN for a new challenge", async () => {
    const { rerender } = render(<ChallengeCard key="c1" challenge={challenge} send={() => {}} dispatch={() => {}} />);
    await userEvent.click(screen.getByRole("button", { name: "1" }));
    rerender(<ChallengeCard key="c2" challenge={{ id: "c2", text: "other" }} send={() => {}} dispatch={() => {}} />);
    expect(screen.getByTestId("pin-dots").textContent).toBe("");
  });
});

describe("<Overlay> challenge", () => {
  const base = { alerts: [], connection: "open" as const, deviceOnline: true, voiceMode: "idle" as const, send: () => {}, dispatch: () => {} };
  it("draws the challenge card above the stage when one is pending", () => {
    render(<Overlay {...base} approval={null} challenge={challenge} />);
    expect(screen.getByRole("alertdialog", { name: /was that you/i })).toBeTruthy();
  });
  it("draws nothing without a challenge", () => {
    render(<Overlay {...base} approval={null} challenge={null} />);
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
});

describe("<OwnerMenu> voice entry", () => {
  const open = async () => {
    await userEvent.keyboard("{Escape}");
  };
  it("offers voice enrollment when voice is available", async () => {
    const onEnroll = vi.fn();
    render(<OwnerMenu muted={false} onToggleMute={() => {}} onSignedOut={() => {}} voiceAvailable voiceEnrolled={false} onEnroll={onEnroll} />);
    await open();
    await userEvent.click(screen.getByRole("button", { name: /enroll my voice/i }));
    expect(onEnroll).toHaveBeenCalled();
  });
  it("calls it voice settings once enrolled", async () => {
    render(<OwnerMenu muted={false} onToggleMute={() => {}} onSignedOut={() => {}} voiceAvailable voiceEnrolled onEnroll={() => {}} />);
    await open();
    expect(screen.getByRole("button", { name: /voice settings/i })).toBeTruthy();
  });
  it("hides it when voice is not available", async () => {
    render(<OwnerMenu muted={false} onToggleMute={() => {}} onSignedOut={() => {}} voiceAvailable={false} voiceEnrolled={false} onEnroll={() => {}} />);
    await open();
    expect(screen.queryByRole("button", { name: /voice/i })).toBeNull();
  });
});
