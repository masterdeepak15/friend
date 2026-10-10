import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SecurityTab, httpChangeSecrets } from "./SecurityTab";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const type = (label: RegExp | string, text: string) => userEvent.type(screen.getByLabelText(label), text);

describe("<SecurityTab>", () => {
  it("sends the current password and a new password, says it worked and clears the boxes", async () => {
    const change = vi.fn(async () => ({ signedOutOthers: true }));
    render(<SecurityTab change={change} />);
    await type("Current password", "old password");
    await type("New password", "a brand new password");
    await type("New password again", "a brand new password");
    await userEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(change).toHaveBeenCalledWith({ current: "old password", newPassword: "a brand new password" });
    expect((await screen.findByRole("status")).textContent).toMatch(/Password changed\. Other browsers and phones were signed out/);
    expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe("");
  });

  it("sends only the PIN when only a PIN was typed, keeping digits only", async () => {
    const change = vi.fn(async () => ({ signedOutOthers: false }));
    render(<SecurityTab change={change} />);
    await type("Current password", "old password");
    await type("New PIN", "12ab3456");
    await type("New PIN again", "123456");
    await userEvent.click(screen.getByRole("button", { name: "Change" }));
    expect(change).toHaveBeenCalledWith({ current: "old password", newPin: "123456" });
    expect((await screen.findByRole("status")).textContent).toBe("PIN changed.");
  });

  it("checks the entries before sending anything", async () => {
    const change = vi.fn(async () => ({ signedOutOthers: false }));
    render(<SecurityTab change={change} />);
    const go = () => userEvent.click(screen.getByRole("button", { name: "Change" }));
    await go();
    expect((await screen.findByRole("alert")).textContent).toMatch(/current password/);
    await type("Current password", "old");
    await go();
    expect(screen.getByRole("alert").textContent).toMatch(/new password or a new PIN/);
    await type("New password", "short");
    await go();
    expect(screen.getByRole("alert").textContent).toMatch(/at least 8/);
    await userEvent.clear(screen.getByLabelText("New password"));
    await type("New password", "long enough pw");
    await type("New password again", "different pw");
    await go();
    expect(screen.getByRole("alert").textContent).toMatch(/not the same/);
    expect(change).not.toHaveBeenCalled();
  });

  it("shows the server's reason and clears the wrong current password", async () => {
    const change = vi.fn(async () => {
      throw new Error("The current password is wrong. 2 tries left.");
    });
    render(<SecurityTab change={change} />);
    await type("Current password", "nope");
    await type("New PIN", "123456");
    await type("New PIN again", "123456");
    await userEvent.click(screen.getByRole("button", { name: "Change" }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/wrong\. 2 tries left/);
    await waitFor(() => expect((screen.getByLabelText("Current password") as HTMLInputElement).value).toBe(""));
  });
});

describe("httpChangeSecrets", () => {
  const reply = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });

  it("posts the change and returns whether other browsers were signed out", async () => {
    const fetchMock = vi.fn(async () => reply(200, { ok: true, signedOutOthers: true }));
    vi.stubGlobal("fetch", fetchMock);
    await expect(httpChangeSecrets({ current: "a", newPassword: "bbbbbbbb" })).resolves.toEqual({ signedOutOthers: true });
    expect(fetchMock).toHaveBeenCalledWith("/api/account/secret", expect.objectContaining({ method: "POST" }));
  });

  it("turns a wrong password into a sentence with the tries left", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(401, { error: "The current password is wrong.", triesLeft: 1 })));
    await expect(httpChangeSecrets({ current: "a", newPin: "123456" })).rejects.toThrow("The current password is wrong. 1 try left.");
  });
});
