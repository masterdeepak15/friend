import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { StartupTab, type SystemApi, type SystemInfo } from "./StartupTab";

afterEach(cleanup);

const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const info = (over: Partial<SystemInfo> = {}, update: Partial<SystemInfo["update"]> = {}, autostart: Partial<SystemInfo["autostart"]> = {}): SystemInfo => ({
  version: "0.1.44",
  auto: true,
  update: { current: "0.1.44", latest: "0.1.44", checkedAt: Date.UTC(2026, 9, 14, 8, 30), available: false, applying: false, canApply: true, error: null, ...update },
  autostart: { supported: true, enabled: false, kind: "systemd", ...autostart },
  ...over,
});
function api(i: SystemInfo = info()): SystemApi {
  return {
    info: vi.fn(async () => i),
    check: vi.fn(async () => ({ ...i.update, latest: "0.1.45", available: true, checkedAt: Date.now() })),
    update: vi.fn(async () => ({ ok: true, message: "Updating to 0.1.45. Friend restarts in a moment: reload this page afterwards." })),
    setAutostart: vi.fn(async (enabled: boolean) => ({ ok: true, message: enabled ? "Friend will start by itself when you sign in to this computer." : "Friend will no longer start by itself when you sign in.", status: { ...i.autostart, enabled } })),
  };
}
const show = (a: SystemApi, auto = true, onAuto = vi.fn()) => render(<StartupTab api={a} auto={auto} onAuto={onAuto} />);

describe("starting with the computer", () => {
  it("shows whether Friend starts by itself", async () => {
    show(api());
    expect(await screen.findByText(/does not start by itself yet/i)).toBeTruthy();
    cleanup();
    show(api(info({}, {}, { enabled: true })));
    expect(await screen.findByText(/starts by itself when you sign in/i)).toBeTruthy();
  });

  it("turns it on with the PIN, and says what happened", async () => {
    const a = api();
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: /start friend when this computer starts/i }));
    expect(screen.getByText(/enter your pin/i)).toBeTruthy();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    await waitFor(() => expect(a.setAutostart).toHaveBeenCalledWith(true, "123456"));
    expect(await screen.findByText(/will start by itself when you sign in/i)).toBeTruthy();
  });

  it("turns it off the same way", async () => {
    const a = api(info({}, {}, { enabled: true }));
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: /stop starting friend with this computer/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    await waitFor(() => expect(a.setAutostart).toHaveBeenCalledWith(false, "123456"));
  });

  it("shows why it did not work, and does not claim success", async () => {
    const a = api();
    (a.setAutostart as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Incorrect PIN"));
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: /start friend when this computer starts/i }));
    await typePin("000000");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Incorrect PIN/);
  });

  it("goes back from the PIN step without doing anything", async () => {
    const a = api();
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: /start friend when this computer starts/i }));
    await userEvent.click(screen.getByRole("button", { name: /^back$/i }));
    expect(a.setAutostart).not.toHaveBeenCalled();
  });

  it("says plainly when this computer cannot do it", async () => {
    show(api(info({}, {}, { supported: false, kind: "none" })));
    expect(await screen.findByText(/not supported on this computer/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /start friend when this computer starts/i })).toBeNull();
  });
});

describe("updates", () => {
  it("shows the version and when it last looked", async () => {
    show(api());
    expect(await screen.findByText(/friend 0\.1\.44/i)).toBeTruthy();
    expect(screen.getByText(/up to date/i)).toBeTruthy();
  });

  it("looks for a newer version when asked, and offers to update", async () => {
    const a = api();
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: /check for updates/i }));
    await waitFor(() => expect(a.check).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/0\.1\.45 is available/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /update now/i })).toBeTruthy();
  });

  it("updates now with the PIN", async () => {
    const a = api(info({}, { latest: "0.1.45", available: true }));
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: /update now/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    await waitFor(() => expect(a.update).toHaveBeenCalledWith("123456"));
    expect(await screen.findByText(/friend restarts in a moment/i)).toBeTruthy();
  });

  it("says what to do when Friend runs in a terminal and cannot restart itself", async () => {
    show(api(info({}, { latest: "0.1.45", available: true, canApply: false })));
    expect(await screen.findByText(/friend upgrade/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /update now/i })).toBeNull();
  });

  it("shows an update that is already running", async () => {
    show(api(info({}, { latest: "0.1.45", available: true, applying: true })));
    expect(await screen.findByText(/updating/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /update now/i })).toBeNull();
  });

  it("shows when it could not ask npm", async () => {
    show(api(info({}, { latest: null, error: "Could not ask npm for the newest version. Check the internet connection." })));
    expect(await screen.findByText(/could not ask npm/i)).toBeTruthy();
  });

  it("has a switch for updating by itself that is saved with the other settings, not by itself", async () => {
    const onAuto = vi.fn();
    show(api(), true, onAuto);
    const box = (await screen.findByLabelText(/update friend by itself/i)) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await userEvent.click(box);
    expect(onAuto).toHaveBeenCalledWith(false);
  });

  it("explains what the switch does", async () => {
    show(api(), false);
    expect(await screen.findByText(/looks for a newer friend when it starts/i)).toBeTruthy();
    expect((screen.getByLabelText(/update friend by itself/i) as HTMLInputElement).checked).toBe(false);
  });
});
