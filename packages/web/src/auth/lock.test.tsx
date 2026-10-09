import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { LoginScreen, clock } from "./LoginScreen";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

describe("nothing of the home screen shows before sign-in", () => {
  const routes = (state: unknown, session: unknown | Error) =>
    vi.fn(async (url: string) => {
      if (url === "/api/state") return reply(200, state);
      if (url === "/api/session") {
        if (session instanceof Error) throw session;
        return reply(200, session);
      }
      return reply(404, {});
    });

  it("shows the sign-in screen, and never the stage, to a browser that is not signed in", async () => {
    const fetchMock = routes({ hasOwner: true }, { signedIn: false });
    vi.stubGlobal("fetch", fetchMock);
    const { container } = render(<App />);
    expect(container.querySelector('[data-testid="stage"]')).toBeNull(); // not while it is still asking
    expect(await screen.findByLabelText(/password/i)).toBeTruthy();
    expect(container.querySelector('[data-testid="stage"]')).toBeNull();
    // and it never even tried to open the screen's connection or fetch the conversation
    expect(fetchMock.mock.calls.map((c) => c[0])).toEqual(["/api/state", "/api/session"]);
  });

  it("shows the sign-in screen when the server cannot be asked, not the stage", async () => {
    vi.stubGlobal("fetch", routes({ hasOwner: true }, new Error("offline")));
    const { container } = render(<App />);
    expect(await screen.findByLabelText(/password/i)).toBeTruthy();
    expect(container.querySelector('[data-testid="stage"]')).toBeNull();
  });

  it("shows the sign-in screen when the answer is anything but a clear yes", async () => {
    vi.stubGlobal("fetch", routes({ hasOwner: true }, { signedIn: "true" }));
    render(<App />);
    expect(await screen.findByLabelText(/password/i)).toBeTruthy();
  });

  it("shows the setup screen when there is no owner yet", async () => {
    vi.stubGlobal("fetch", routes({ hasOwner: false }, { signedIn: false }));
    render(<App />);
    expect(await screen.findByLabelText(/^password/i)).toBeTruthy();
    expect(screen.getByLabelText(/pin/i)).toBeTruthy();
  });

  it("draws nothing at all while it is still asking", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => {})));
    const { container } = render(<App />);
    expect(container.querySelector('[data-testid="stage"]')).toBeNull();
    expect(container.querySelector("input")).toBeNull();
    expect(container.querySelector(".boot")).toBeTruthy();
  });
});

describe("<LoginScreen> after wrong passwords", () => {
  it("says how many tries are left", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(401, { error: "Invalid credentials", triesLeft: 2 })));
    render(<LoginScreen onLoggedIn={() => {}} />);
    await userEvent.type(screen.getByLabelText(/password/i), "nope{Enter}");
    expect((await screen.findByRole("alert")).textContent).toMatch(/2 tries left/);
    expect((screen.getByLabelText(/password/i) as HTMLInputElement).value).toBe(""); // the wrong guess is cleared
  });

  it("locks the form with a countdown when the server says so, then opens it again", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(401, { error: "Wrong password. Locked for 2 seconds.", triesLeft: 0, retryAfterSeconds: 2 })));
    render(<LoginScreen onLoggedIn={() => {}} />);
    await userEvent.type(screen.getByLabelText(/password/i), "nope{Enter}");
    const button = await screen.findByRole("button", { name: /Locked 0:0[12]/ });
    expect((button as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByLabelText(/password/i) as HTMLInputElement).disabled).toBe(true);
    expect(screen.getByTestId("lock-countdown").textContent).toMatch(/Try again in 0:0[12]/);

    // the lock is a real time: it opens again by itself
    await waitFor(() => expect((screen.getByLabelText(/password/i) as HTMLInputElement).disabled).toBe(false), { timeout: 4000 });
    expect(screen.queryByTestId("lock-countdown")).toBeNull();
    expect(screen.getByText(/^Sign in$/)).toBeTruthy();
  });

  it("shows a lock that is already in force (a refreshed page, another try)", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(429, { error: "Too many wrong passwords. Try again in 4 minutes.", retryAfterSeconds: 240 })));
    render(<LoginScreen onLoggedIn={() => {}} />);
    await userEvent.type(screen.getByLabelText(/password/i), "x{Enter}");
    expect(await screen.findByTestId("lock-countdown")).toBeTruthy();
    expect((await screen.findByRole("alert")).textContent).toMatch(/too many wrong passwords/i);
    expect(screen.getByRole("button", { name: /Locked 4:00/ })).toBeTruthy();
  });

  it("formats the countdown", () => {
    expect(clock(0)).toBe("0:00");
    expect(clock(9)).toBe("0:09");
    expect(clock(75)).toBe("1:15");
    expect(clock(3600)).toBe("60:00");
  });
});
