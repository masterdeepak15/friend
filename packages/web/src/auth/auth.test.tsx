import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { LoginScreen } from "./LoginScreen";
import { SetupScreen } from "./SetupScreen";

afterEach(() => vi.unstubAllGlobals());

const jsonResponse = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

describe("<LoginScreen>", () => {
  it("posts the password and reports success", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const done = vi.fn();
    render(<LoginScreen onLoggedIn={done} />);
    await userEvent.type(screen.getByLabelText(/password/i), "correct horse battery{Enter}");
    expect(fetchMock).toHaveBeenCalledWith("/api/login", expect.objectContaining({ method: "POST" }));
    expect(JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body)).toEqual({ password: "correct horse battery" });
    expect(done).toHaveBeenCalled();
  });
  it("shows a message for a wrong password and a lockout", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(401, { error: "Invalid credentials" })));
    render(<LoginScreen onLoggedIn={() => {}} />);
    await userEvent.type(screen.getByLabelText(/password/i), "nope{Enter}");
    expect((await screen.findByRole("alert")).textContent).toMatch(/invalid/i);
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(429, { error: "Too many attempts" })));
    await userEvent.type(screen.getByLabelText(/password/i), "x{Enter}");
    expect((await screen.findByRole("alert")).textContent).toMatch(/too many/i);
  });
});

describe("<SetupScreen>", () => {
  it("posts password, PIN and assistant name", async () => {
    const fetchMock = vi.fn(async () => jsonResponse(200, { ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const done = vi.fn();
    render(<SetupScreen onDone={done} />);
    await userEvent.type(screen.getByLabelText(/^password/i), "correct horse battery");
    await userEvent.type(screen.getByLabelText(/pin/i), "123456");
    await userEvent.type(screen.getByLabelText(/name/i), "Jarvis{Enter}");
    const body = JSON.parse((fetchMock.mock.calls[0] as unknown as [string, { body: string }])[1].body);
    expect(body).toEqual({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
    expect(done).toHaveBeenCalled();
  });
  it("shows the server error, such as setup being blocked off the local machine", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse(403, { error: "Setup is not available" })));
    render(<SetupScreen onDone={() => {}} />);
    await userEvent.type(screen.getByLabelText(/^password/i), "correct horse battery");
    await userEvent.type(screen.getByLabelText(/pin/i), "123456");
    await userEvent.type(screen.getByLabelText(/name/i), "J{Enter}");
    expect((await screen.findByRole("alert")).textContent).toMatch(/setup is not available/i);
  });
});
