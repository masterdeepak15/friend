import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { IntegrationConfig } from "./IntegrationConfig";
import type { IntegrationEntry } from "./pluginsApi";
import { SoundCloudForm, soundcloudClientIdProblem, type SoundCloudApi, type SoundCloudInfo } from "./SoundCloudForm";

afterEach(cleanup);

const CLIENT = "abc123DEF456ghi789jkl012MNO345pq";
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const info = (over: Partial<SoundCloudInfo> = {}): SoundCloudInfo => ({
  status: { connected: false, needs: "Add your SoundCloud client id in Plugins, SoundCloud.", account: null },
  redirectUri: "https://friend.example.com/api/music/oauth/callback",
  clientId: "",
  secretSet: false,
  ...over,
});
const api = (i: SoundCloudInfo = info()): SoundCloudApi => ({
  info: vi.fn(async () => i),
  saveCredentials: vi.fn(async () => {}),
  connect: vi.fn(async () => "https://secure.soundcloud.com/authorize?x=1"),
  disconnect: vi.fn(async () => {}),
});

describe("the SoundCloud Configure page", () => {
  it("shows the address to register in the SoundCloud app and what is missing", async () => {
    render(<SoundCloudForm api={api()} />);
    expect(await screen.findByDisplayValue("https://friend.example.com/api/music/oauth/callback")).toBeTruthy();
    expect(screen.getByText(/Add your SoundCloud client id/)).toBeTruthy();
  });

  it("rejects a client id that cannot be right, before asking for the PIN", async () => {
    render(<SoundCloudForm api={api()} />);
    await userEvent.type(await screen.findByLabelText(/client id/i), "../../x");
    expect(screen.getByRole("alert").textContent).toMatch(/letters and digits/i);
    expect((screen.getByRole("button", { name: /save/i }) as HTMLButtonElement).disabled).toBe(true);
    expect(soundcloudClientIdProblem(CLIENT)).toBeNull();
    expect(soundcloudClientIdProblem("")).toBeNull();
    expect(soundcloudClientIdProblem("short")).not.toBeNull();
  });

  it("saves the client id and the secret with the PIN, and the secret is a hidden field that is cleared after", async () => {
    const a = api();
    render(<SoundCloudForm api={a} />);
    await userEvent.type(await screen.findByLabelText(/client id/i), CLIENT);
    const secret = screen.getByLabelText(/client secret/i) as HTMLInputElement;
    expect(secret.type).toBe("password");
    await userEvent.type(secret, "s3cr3t-value-xyz");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(a.saveCredentials).toHaveBeenCalledWith(CLIENT, "s3cr3t-value-xyz", "123456"));
    await waitFor(() => expect((screen.getByLabelText(/client secret/i) as HTMLInputElement).value).toBe(""));
  });

  it("says the secret is saved without showing it, and can save the id alone", async () => {
    const a = api(info({ clientId: CLIENT, secretSet: true }));
    render(<SoundCloudForm api={a} />);
    expect(await screen.findByText(/secret is saved/i)).toBeTruthy();
    await userEvent.clear(screen.getByLabelText(/client id/i));
    await userEvent.type(screen.getByLabelText(/client id/i), "zzz123DEF456ghi789jkl012MNO345pq");
    await userEvent.click(screen.getByRole("button", { name: /save/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    await waitFor(() => expect(a.saveCredentials).toHaveBeenCalledWith("zzz123DEF456ghi789jkl012MNO345pq", undefined, "123456"));
  });

  it("cannot connect before the client id and secret are saved", async () => {
    render(<SoundCloudForm api={api()} />);
    expect(((await screen.findByRole("button", { name: /^connect/i })) as HTMLButtonElement).disabled).toBe(true);
  });

  it("connects with the PIN and sends the browser to SoundCloud", async () => {
    const a = api(info({ clientId: CLIENT, secretSet: true, status: { connected: false, needs: "Connect your SoundCloud account in Plugins, SoundCloud.", account: null } }));
    const go = vi.fn();
    render(<SoundCloudForm api={a} navigate={go} />);
    await userEvent.click(await screen.findByRole("button", { name: /^connect/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    await waitFor(() => expect(a.connect).toHaveBeenCalledWith("123456"));
    expect(go).toHaveBeenCalledWith("https://secure.soundcloud.com/authorize?x=1");
  });

  it("shows who is connected and disconnects with the PIN", async () => {
    const a = api(info({ clientId: CLIENT, secretSet: true, status: { connected: true, needs: null, account: "Owner Name" } }));
    render(<SoundCloudForm api={a} />);
    expect(await screen.findByText(/Connected as Owner Name/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /disconnect/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    await waitFor(() => expect(a.disconnect).toHaveBeenCalledWith("123456"));
  });

  it("shows a wrong PIN as the server said it", async () => {
    const a = api(info({ clientId: CLIENT, secretSet: true }));
    (a.connect as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Wrong PIN."));
    render(<SoundCloudForm api={a} />);
    await userEvent.click(await screen.findByRole("button", { name: /^connect/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Wrong PIN/);
  });

  it("is what the SoundCloud plugin's Configure shows", async () => {
    const entry: IntegrationEntry = { id: "soundcloud", name: "SoundCloud", description: "x", installed: true, enabled: false, state: "needs-setup", detail: "", steps: [{ text: "Paste the app details.", done: false }] };
    const settingsApi = { get: vi.fn(async () => ({}) as never), save: vi.fn() };
    render(<IntegrationConfig integration={entry} onBack={() => {}} settingsApi={settingsApi as never} soundcloudApi={api()} />);
    expect(await screen.findByLabelText(/client secret/i)).toBeTruthy();
  });
});
