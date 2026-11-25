import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OAuthSection } from "./OAuthSection";
import type { OAuthApi, OAuthState } from "./oauthApi";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

const google = { id: "google", name: "Google (Gmail)", configured: true, connected: false, needsReconnect: false, account: null, redirectUri: "https://maya.example.com/api/oauth/callback" };
const base = (over: Partial<OAuthState> = {}): OAuthState => ({ services: [google], connectors: [], redirectUri: google.redirectUri, ...over });

function fake(state: OAuthState, over: Partial<OAuthApi> = {}): OAuthApi {
  return {
    state: vi.fn(async () => state),
    connectService: vi.fn(async () => ({ link: "https://maya.example.com/api/oauth/start/T1", sent: false })),
    disconnectService: vi.fn(async () => {}),
    connectConnector: vi.fn(async () => ({ link: "https://maya.example.com/api/oauth/start/T2", sent: false })),
    disconnectConnector: vi.fn(async () => {}),
    setClient: vi.fn(async () => {}),
    ...over,
  };
}

describe("OAuthSection", () => {
  it("says what state each service is in", async () => {
    const api = fake(base({ services: [{ ...google, configured: false }, { ...google, id: "b", name: "B", connected: true, account: "me@example.com" }, { ...google, id: "c", name: "C", needsReconnect: true, connected: true }] }));
    render(<OAuthSection api={api} />);
    expect(await screen.findByText("Not set up")).toBeTruthy();
    expect(screen.getByText("Connected as me@example.com")).toBeTruthy();
    expect(screen.getByText("Reconnect needed")).toBeTruthy();
  });

  it("when the host has not registered a client, shows the exact return address to register and offers no Connect", async () => {
    render(<OAuthSection api={fake(base({ services: [{ ...google, configured: false }] }))} />);
    expect(await screen.findByText("https://maya.example.com/api/oauth/callback")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Connect" })).toBeNull();
    expect(screen.getByRole("button", { name: "Add client ID" })).toBeTruthy();
  });

  it("Connect opens the link in a page that cannot reach back, and tells the owner what to do", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const api = fake(base());
    render(<OAuthSection api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Connect" }));
    await waitFor(() => expect(open).toHaveBeenCalledWith("https://maya.example.com/api/oauth/start/T1", "_blank", "noopener,noreferrer"));
    expect(api.connectService).toHaveBeenCalledWith("google", false);
    expect(await screen.findByText(/Finish in the page that opened/)).toBeTruthy();
  });

  it("'Send the link to my phone' sends it there and does not open anything here", async () => {
    const open = vi.spyOn(window, "open").mockReturnValue(null);
    const api = fake(base(), { connectService: vi.fn(async () => ({ link: "https://x/y", sent: true })) });
    render(<OAuthSection api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Send the link to my phone" }));
    expect(await screen.findByText(/sent to your phone/)).toBeTruthy();
    expect(open).not.toHaveBeenCalled();
    expect(api.connectService).toHaveBeenCalledWith("google", true);
  });

  it("says so when there is no phone app to send to", async () => {
    render(<OAuthSection api={fake(base())} />);
    await userEvent.click(await screen.findByRole("button", { name: "Send the link to my phone" }));
    expect(await screen.findByText(/no phone app linked/)).toBeTruthy();
  });

  it("Disconnect asks once before it does anything", async () => {
    const api = fake(base({ services: [{ ...google, connected: true, account: "me@example.com" }] }));
    render(<OAuthSection api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Disconnect" }));
    expect(api.disconnectService).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Really disconnect?" }));
    await waitFor(() => expect(api.disconnectService).toHaveBeenCalledWith("google"));
  });

  it("shows a connector that signs in with a link as waiting for approval, with the same two buttons", async () => {
    const api = fake(base({ services: [], connectors: [{ id: "mail", name: "Mail server", status: "needs-approval", connected: false, account: null }] }));
    render(<OAuthSection api={api} />);
    expect(await screen.findByText("Waiting for your approval")).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: "Send the link to my phone" }));
    await waitFor(() => expect(api.connectConnector).toHaveBeenCalledWith("mail", true));
  });

  it("keeps the client ID behind the PIN and never shows what was typed as a secret", async () => {
    const api = fake(base());
    render(<OAuthSection api={api} />);
    await userEvent.click(await screen.findByRole("button", { name: "Change client ID" }));
    await userEvent.type(screen.getByLabelText("Client ID"), "abc-123456789");
    expect((screen.getByLabelText(/Client secret/) as HTMLInputElement).type).toBe("password");
    await userEvent.click(screen.getByRole("button", { name: "Save…" }));
    expect(screen.getByText(/Enter your PIN/)).toBeTruthy();
    expect(api.setClient).not.toHaveBeenCalled();
  });

  it("stays hidden when the server cannot be read", async () => {
    const api = fake(base(), { state: vi.fn(async () => { throw new Error("down"); }) });
    const { container } = render(<OAuthSection api={api} />);
    await waitFor(() => expect(api.state).toHaveBeenCalled());
    expect(container.textContent).toBe("");
  });
});
