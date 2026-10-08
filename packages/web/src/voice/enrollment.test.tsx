import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { EnrollApi, EnrollState } from "./enrollApi";
import { EnrollmentFlow } from "./EnrollmentFlow";

afterEach(cleanup);

const fresh: EnrollState = { enrolled: false, samples: 0, min: 3, max: 8 };

function setup(state: Partial<EnrollState> = {}, overrides: Partial<EnrollApi> = {}) {
  let count = state.samples ?? 0;
  const api: EnrollApi = {
    state: vi.fn(async () => ({ ...fresh, ...state, samples: count })),
    sample: vi.fn(async () => ({ count: ++count, note: null })),
    finish: vi.fn(async () => ({ samples: count })),
    cancel: vi.fn(async () => {}),
    remove: vi.fn(async () => {}),
    ...overrides,
  };
  const recorder = {
    start: vi.fn(async () => {}),
    stop: vi.fn(async () => new Blob(["audio"], { type: "audio/webm" })),
    cancel: vi.fn(),
  };
  const onClose = vi.fn();
  render(<EnrollmentFlow api={api} createRecorder={() => recorder} onClose={onClose} />);
  return { api, recorder, onClose };
}

const record = async (times = 1) => {
  for (let i = 0; i < times; i++) {
    await userEvent.click(await screen.findByRole("button", { name: /^record$/i }));
    await userEvent.click(await screen.findByRole("button", { name: /^stop$/i }));
    await waitFor(() => expect(screen.getByRole("button", { name: /^record$/i })).toBeTruthy());
  }
};
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};

describe("<EnrollmentFlow>", () => {
  it("asks for a phrase to read and shows progress", async () => {
    setup();
    expect(await screen.findByText(/phrase 1 of 5/i)).toBeTruthy();
    expect(screen.getByTestId("enroll-phrase").textContent!.length).toBeGreaterThan(10);
    expect(screen.queryByRole("button", { name: /delete my voice/i })).toBeNull();
  });

  it("records on one click and uploads on the next, then moves to the next phrase", async () => {
    const { api, recorder } = setup();
    const first = (await screen.findByTestId("enroll-phrase")).textContent;
    await record();
    expect(recorder.start).toHaveBeenCalledTimes(1);
    expect(recorder.stop).toHaveBeenCalledTimes(1);
    expect(api.sample).toHaveBeenCalledTimes(1);
    expect((api.sample as ReturnType<typeof vi.fn>).mock.calls[0]![0]).toBeInstanceOf(Blob);
    expect(screen.getByText(/phrase 2 of 5/i)).toBeTruthy();
    expect(screen.getByTestId("enroll-phrase").textContent).not.toBe(first);
  });

  it("shows the server's quality note", async () => {
    setup({}, { sample: vi.fn(async () => ({ count: 1, note: "Speak close to the microphone." })) });
    await record();
    expect((await screen.findByRole("status")).textContent).toContain("Speak close to the microphone.");
  });

  it("offers to save only after enough phrases, and saving needs the PIN", async () => {
    const { api } = setup();
    await screen.findByText(/phrase 1 of 5/i);
    await record(2);
    expect((screen.getByRole("button", { name: /save my voice/i }) as HTMLButtonElement).disabled).toBe(true);
    await record();
    await userEvent.click(screen.getByRole("button", { name: /save my voice/i }));
    const save = screen.getByRole("button", { name: /^save$/i }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);
    await typePin("12345");
    expect(save.disabled).toBe(true);
    await typePin("6");
    await userEvent.click(save);
    expect(api.finish).toHaveBeenCalledWith("123456");
    expect(await screen.findByText(/your voice is saved/i)).toBeTruthy();
  });

  it("shows the server's reason when saving fails and lets the owner try again", async () => {
    const finish = vi.fn().mockRejectedValueOnce(new Error("Incorrect PIN.")).mockResolvedValueOnce({ samples: 3 });
    setup({}, { finish });
    await screen.findByText(/phrase 1 of 5/i);
    await record(3);
    await userEvent.click(screen.getByRole("button", { name: /save my voice/i }));
    await typePin("000000");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect((await screen.findByRole("alert")).textContent).toContain("Incorrect PIN.");
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(await screen.findByText(/your voice is saved/i)).toBeTruthy();
  });

  it("reports a microphone that cannot be opened", async () => {
    const { recorder } = setup();
    recorder.start.mockRejectedValueOnce(new Error("Microphone permission was denied."));
    await userEvent.click(await screen.findByRole("button", { name: /^record$/i }));
    expect((await screen.findByRole("alert")).textContent).toContain("Microphone permission was denied.");
    expect(screen.getByRole("button", { name: /^record$/i })).toBeTruthy();
  });

  it("cancel discards the samples and closes", async () => {
    const { api, onClose } = setup();
    await screen.findByText(/phrase 1 of 5/i);
    await record();
    await userEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(api.cancel).toHaveBeenCalled();
    expect(onClose).toHaveBeenCalled();
  });

  it("releases the microphone if it is closed while recording", async () => {
    const { recorder } = setup();
    await userEvent.click(await screen.findByRole("button", { name: /^record$/i }));
    cleanup();
    expect(recorder.cancel).toHaveBeenCalled();
  });

  it("deletes an enrolled voice only with the PIN", async () => {
    const { api } = setup({ enrolled: true });
    await userEvent.click(await screen.findByRole("button", { name: /delete my voice/i }));
    const confirm = screen.getByRole("button", { name: /^delete$/i }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await typePin("123456");
    await userEvent.click(confirm);
    expect(api.remove).toHaveBeenCalledWith("123456");
    expect(await screen.findByText(/voice was deleted/i)).toBeTruthy();
  });

  it("tells a re-enrolling owner that the new recording replaces the old voice", async () => {
    setup({ enrolled: true });
    expect(await screen.findByText(/replaces/i)).toBeTruthy();
  });

  it("ignores a late reply after it was closed", async () => {
    let release: (v: EnrollState) => void = () => {};
    const state = vi.fn(() => new Promise<EnrollState>((r) => (release = r)));
    const { unmount } = render(<EnrollmentFlow api={{ state } as unknown as EnrollApi} onClose={() => {}} />);
    unmount();
    await act(async () => release(fresh)); // must not throw or warn about an unmounted component
  });
});
