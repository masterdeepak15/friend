import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationConfig } from "./IntegrationConfig";
import type { IntegrationEntry } from "./pluginsApi";
import { SpotifyForm, spotifyClientIdProblem, type SpotifyApi, type SpotifyInfo } from "./SpotifyForm";

afterEach(cleanup);

const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const info = (over: Partial<SpotifyInfo> = {}): SpotifyInfo => ({
  status: { connected: false, needs: "Add your Spotify client id in Plugins, Spotify.", account: null },
  redirectUri: "https://friend.example.com/api/music/oauth/callback",
  clientId: "",
  ...over,
});
const api = (i: SpotifyInfo = info()): SpotifyApi => ({
  info: vi.fn(async () => i),
  saveClientId: vi.fn(async () => {}),
  connect: vi.fn(async () => "https://accounts.spotify.com/authorize?x=1"),
  disconnect: vi.fn(async () => {}),
});

describe("the Spotify Configure page", () => {
  it("shows the address to register in the Spotify app and what is missing", async () => {
    render(<SpotifyForm api={api()} />);
    expect(await screen.findByDisplayValue("https://friend.example.com/api/music/oauth/callback")).toBeTruthy();
    expect(screen.getByText(/Add your Spotify client id/)).toBeTruthy();
  });

  it("rejects a client id that cannot be right, before asking for the PIN", async () => {
    const a = api();
    render(<SpotifyForm api={a} />);
    await userEvent.type(await screen.findByLabelText(/client id/i), "../../x");
    expect(screen.getByRole("alert").textContent).toMatch(/letters and digits/i);
    expect((screen.getByRole("button", { name: /save client id/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(spotifyClientIdProblem("abc123DEF456ghi789")).toBeNull();
    expect(spotifyClientIdProblem("")).toBeNull();
    expect(spotifyClientIdProblem("short")).not.toBeNull();
  });

  it("saves the client id with the PIN", async () => {
    const a = api();
    render(<SpotifyForm api={a} />);
    await userEvent.type(await screen.findByLabelText(/client id/i), "abc123DEF456ghi789");
    await userEvent.click(screen.getByRole("button", { name: /save client id/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(a.saveClientId).toHaveBeenCalledWith("abc123DEF456ghi789", "123456"));
  });

  it("cannot connect before a client id is saved", async () => {
    render(<SpotifyForm api={api()} />);
    const connect = (await screen.findByRole("button", { name: /^connect/i })) as HTMLButtonElement;
    expect(connect.disabled).toBe(true);
  });

  it("connects with the PIN and sends the browser to Spotify", async () => {
    const a = api(info({ clientId: "abc123DEF456ghi789", status: { connected: false, needs: "Connect your Spotify account in Plugins, Spotify.", account: null } }));
    const go = vi.fn();
    render(<SpotifyForm api={a} navigate={go} />);
    await userEvent.click(await screen.findByRole("button", { name: /^connect/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    await waitFor(() => expect(a.connect).toHaveBeenCalledWith("123456"));
    expect(go).toHaveBeenCalledWith("https://accounts.spotify.com/authorize?x=1");
  });

  it("says who is connected, says plainly that a free account cannot play, and disconnects with the PIN", async () => {
    const a = api(info({ clientId: "abc123DEF456ghi789", status: { connected: true, needs: "Spotify Premium is needed to play (searching works).", account: "Test Listener" } }));
    render(<SpotifyForm api={a} />);
    expect(await screen.findByText(/Test Listener/)).toBeTruthy();
    expect(screen.getByText(/Premium is needed to play/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^disconnect/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    await waitFor(() => expect(a.disconnect).toHaveBeenCalledWith("123456"));
  });

  it("shows an error from the server as it is", async () => {
    const a = api(info({ clientId: "abc123DEF456ghi789" }));
    (a.connect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("That PIN is not right."));
    render(<SpotifyForm api={a} navigate={() => {}} />);
    await userEvent.click(await screen.findByRole("button", { name: /^connect/i }));
    await typePin("000000");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/PIN is not right/);
  });
});

describe("inside the plugins screen", () => {
  it("the Spotify entry opens the Spotify form, with no general Save button", async () => {
    const entry: IntegrationEntry = { id: "spotify", name: "Spotify", description: "x", installed: true, enabled: false, state: "needs-setup", detail: "Add your Spotify client id (press Configure).", steps: [{ text: "Paste the app's Client ID.", done: false }] };
    const settingsApi = { get: vi.fn(async () => ({}) as never), save: vi.fn() };
    render(<IntegrationConfig integration={entry} onBack={() => {}} settingsApi={settingsApi as never} spotifyApi={api()} />);
    expect(await screen.findByDisplayValue(/oauth\/callback/)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^save…?$/i })).toBeNull();
  });
});
