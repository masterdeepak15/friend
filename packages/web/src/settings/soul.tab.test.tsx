import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SoulTab, type SoulApi, type SoulInfo } from "./SoulTab";

afterEach(cleanup);

const info = (o: Partial<SoulInfo> = {}): SoulInfo => ({ text: "# Soul\nYou are my assistant.", isDefault: true, max: 3000, versions: [], ...o });
const pad = async (digits: string) => {
  for (const d of digits) await userEvent.click(screen.getByRole("button", { name: d }));
};

describe("<SoulTab>", () => {
  it("shows the soul, and saves an edit only after the PIN", async () => {
    const save = vi.fn(async (text: string) => info({ text, isDefault: false }));
    const api: SoulApi = { get: async () => info(), save, restore: vi.fn() };
    render(<SoulTab api={api} />);
    const box = (await screen.findByLabelText("Soul")) as HTMLTextAreaElement;
    expect(box.value).toMatch(/You are my assistant/);
    expect((screen.getByRole("button", { name: "Save soul" }) as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(box, " Be calm.");
    await userEvent.click(screen.getByRole("button", { name: "Save soul" }));
    expect(save).not.toHaveBeenCalled();
    await pad("123456");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(save).toHaveBeenCalledWith("# Soul\nYou are my assistant. Be calm.", "123456");
    expect((await screen.findByRole("status")).textContent).toMatch(/Saved/);
  });

  it("brings back the earlier soul with the PIN, and shows a wrong PIN", async () => {
    const restore = vi.fn(async () => {
      throw new Error("Incorrect PIN");
    });
    const api: SoulApi = { get: async () => info({ isDefault: false, versions: [{ at: 1, chars: 10 }] }), save: vi.fn(), restore };
    render(<SoulTab api={api} />);
    await screen.findByLabelText("Soul");
    await userEvent.click(screen.getByRole("button", { name: "Bring back the earlier soul" }));
    await pad("000000");
    await userEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(restore).toHaveBeenCalledWith("previous", "000000");
    expect((await screen.findByRole("alert")).textContent).toBe("Incorrect PIN");
  });

  it("offers no earlier soul when there is none, and no reset when it already is the default", async () => {
    render(<SoulTab api={{ get: async () => info(), save: vi.fn(), restore: vi.fn() }} />);
    await screen.findByLabelText("Soul");
    expect((screen.getByRole("button", { name: "Bring back the earlier soul" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Reset to default" }) as HTMLButtonElement).disabled).toBe(true);
  });
});
