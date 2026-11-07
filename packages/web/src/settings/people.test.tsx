import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PeopleSection, type PeopleApi, type PersonRow } from "./PeopleSection";

afterEach(cleanup);

const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const people: PersonRow[] = [
  { id: 1, name: "Priya", relation: "sister", addedAt: Date.UTC(2026, 10, 7), usable: true },
  { id: 2, name: "Dev", relation: "", addedAt: Date.UTC(2026, 10, 7), usable: false },
];
function api(list: PersonRow[] = people): PeopleApi {
  let current = list;
  return {
    list: vi.fn(async () => current),
    remove: vi.fn(async (id: number) => void (current = current.filter((p) => p.id !== id))),
    forgetAll: vi.fn(async () => void (current = [])),
  };
}

describe("the people Friend remembers", () => {
  it("lists them by name and how they are related, and says who must be introduced again", async () => {
    render(<PeopleSection api={api()} />);
    expect(await screen.findByText(/Priya/)).toBeTruthy();
    expect(screen.getByText(/sister/)).toBeTruthy();
    expect(screen.getByText(/Dev/)).toBeTruthy();
    expect(screen.getByText(/introduce.*again/i)).toBeTruthy();
  });

  it("says so when it remembers nobody", async () => {
    render(<PeopleSection api={api([])} />);
    expect(await screen.findByText(/does not remember anyone/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /forget everyone/i })).toBeNull();
  });

  it("reminds the owner to introduce only people who know and agree, and not children", async () => {
    render(<PeopleSection api={api()} />);
    expect(await screen.findByText(/only people who know/i)).toBeTruthy();
    expect(screen.getByText(/children/i)).toBeTruthy();
  });

  it("forgets one person only after the PIN", async () => {
    const a = api();
    render(<PeopleSection api={a} />);
    await screen.findByText(/Priya/);
    await userEvent.click(screen.getByRole("button", { name: /remove priya/i }));
    expect(a.remove).not.toHaveBeenCalled();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(a.remove).toHaveBeenCalledWith(1, "123456"));
    await waitFor(() => expect(screen.queryByText(/Priya/)).toBeNull());
    expect(screen.getByText(/Dev/)).toBeTruthy();
  });

  it("forgets everyone only after the PIN", async () => {
    const a = api();
    render(<PeopleSection api={a} />);
    await screen.findByText(/Priya/);
    await userEvent.click(screen.getByRole("button", { name: /forget everyone/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    await waitFor(() => expect(a.forgetAll).toHaveBeenCalledWith("123456"));
    expect(await screen.findByText(/does not remember anyone/i)).toBeTruthy();
  });

  it("shows the reason when the PIN is wrong and keeps everyone", async () => {
    const a = api();
    a.remove = vi.fn(async () => Promise.reject(new Error("Incorrect PIN")));
    render(<PeopleSection api={a} />);
    await screen.findByText(/Priya/);
    await userEvent.click(screen.getByRole("button", { name: /remove priya/i }));
    await typePin("000000");
    await userEvent.click(screen.getByRole("button", { name: /continue/i }));
    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText(/Incorrect PIN/)).toBeTruthy();
  });

  it("can be cancelled without anything being removed", async () => {
    const a = api();
    render(<PeopleSection api={a} />);
    await screen.findByText(/Priya/);
    await userEvent.click(screen.getByRole("button", { name: /remove priya/i }));
    await userEvent.click(screen.getByRole("button", { name: /^back$/i }));
    expect(a.remove).not.toHaveBeenCalled();
    expect(screen.getByText(/Priya/)).toBeTruthy();
  });
});
