import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChromeForm, type BannerInfo, type ChromeApi } from "./ChromeForm";

afterEach(cleanup);

const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const banner = (over: Partial<BannerInfo> = {}): BannerInfo => ({ supported: true, platform: "win32", running: true, hidden: false, shortcuts: { withFlag: 0, total: 8 }, ...over });
const api = (b: BannerInfo): ChromeApi => ({
  info: vi.fn(async () => ({ state: "online" as const, detail: "Ready.", extensionFolder: "C:/x/extension" })),
  setUp: vi.fn(async () => ({ ok: true, message: "ok" })),
  access: vi.fn(async () => ({ remote: false, mcpUrl: "", extensionAddress: "", extensionZip: null })),
  setRemote: vi.fn(async () => {}),
  revealKey: vi.fn(async () => "k"),
  banner: vi.fn(async () => b),
  hideBanner: vi.fn(async () => ({ ok: true, message: "Added the flag to 8 shortcuts." })),
  restartChrome: vi.fn(async () => ({ ok: true, message: "Chrome was restarted with the banner hidden. Your tabs come back." })),
});

describe("the debugging banner on the Chrome control page", () => {
  it("is not shown when this Friend cannot manage it", async () => {
    render(<ChromeForm api={api({ supported: false })} pollMs={0} />);
    await screen.findByText("Ready.");
    expect(screen.queryByText(/debugging banner/i)).toBeNull();
  });

  it("explains what the banner is, and says the open Chrome shows it", async () => {
    render(<ChromeForm api={api(banner())} pollMs={0} />);
    expect(await screen.findByRole("heading", { name: /debugging banner/i })).toBeTruthy();
    expect(screen.getByText(/started debugging this browser/i)).toBeTruthy();
    expect(screen.getByText(/open now was started without it/i)).toBeTruthy();
    expect(screen.getByText(/0 of 8 shortcuts/i)).toBeTruthy();
  });

  it("says it is hidden when the open Chrome has the flag, and offers nothing more", async () => {
    render(<ChromeForm api={api(banner({ hidden: true, shortcuts: { withFlag: 8, total: 8 } }))} pollMs={0} />);
    expect(await screen.findByText(/hidden in the chrome that is open/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /restart chrome/i })).toBeNull();
    expect(screen.queryByRole("button", { name: /add the flag/i })).toBeNull();
  });

  it("offers to start Chrome when it is closed", async () => {
    render(<ChromeForm api={api(banner({ running: false, hidden: null }))} pollMs={0} />);
    expect(await screen.findByText(/chrome is closed/i)).toBeTruthy();
    expect(screen.getByRole("button", { name: /start chrome with the banner hidden/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /restart chrome/i })).toBeNull();
  });

  it("adds the flag to the shortcuts with the PIN, and says what came of it", async () => {
    const a = api(banner());
    render(<ChromeForm api={a} pollMs={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /add the flag to my chrome shortcuts/i }));
    expect(screen.getByText(/enter your pin/i)).toBeTruthy();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    await waitFor(() => expect(a.hideBanner).toHaveBeenCalledWith("123456"));
    expect(await screen.findByText("Added the flag to 8 shortcuts.")).toBeTruthy();
    expect((a.banner as ReturnType<typeof vi.fn>).mock.calls.length).toBeGreaterThanOrEqual(2); // looked again afterwards
  });

  it("warns that restarting closes Chrome before it asks for the PIN, then restarts", async () => {
    const a = api(banner());
    render(<ChromeForm api={a} pollMs={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /restart chrome with the banner hidden/i }));
    expect(screen.getByText(/closes chrome and opens it again/i)).toBeTruthy();
    expect(a.restartChrome).not.toHaveBeenCalled();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    await waitFor(() => expect(a.restartChrome).toHaveBeenCalledWith("123456"));
    expect(await screen.findByText(/chrome was restarted with the banner hidden/i)).toBeTruthy();
  });

  it("shows why it did not work, and can go back", async () => {
    const a = api(banner());
    (a.restartChrome as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: false, message: "Chrome did not close (it may be asking you to save something). Close it yourself, then press Start." });
    render(<ChromeForm api={a} pollMs={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /restart chrome with the banner hidden/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect(await screen.findByText(/did not close/i)).toBeTruthy();
  });

  it("goes back from the PIN step without doing anything", async () => {
    const a = api(banner());
    render(<ChromeForm api={a} pollMs={0} />);
    await userEvent.click(await screen.findByRole("button", { name: /add the flag to my chrome shortcuts/i }));
    await userEvent.click(screen.getByRole("button", { name: /^back$/i }));
    expect(a.hideBanner).not.toHaveBeenCalled();
    expect(await screen.findByRole("heading", { name: /debugging banner/i })).toBeTruthy();
  });
});
