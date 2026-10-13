import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationSection, type ConversationApi, type ConversationInfo } from "./ConversationSection";

afterEach(cleanup);

const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};
const info = (over: Partial<ConversationInfo> = {}): ConversationInfo => ({ supported: true, contextTokens: 150_000, autoCompact: true, compactAtTokens: 100_000, ...over });
function api(i = info()): ConversationApi {
  return {
    info: vi.fn(async () => i),
    compact: vi.fn(async () => ({ ok: true, message: "Done. Friend wrote notes on the conversation and started a fresh one from them." })),
    clear: vi.fn(async () => ({ ok: true, message: "Started fresh." })),
  };
}
const show = (a: ConversationApi, over: { autoCompact?: boolean; limit?: number; onChange?: (p: object) => void } = {}) => {
  const onChange = over.onChange ?? vi.fn();
  render(<ConversationSection api={a} autoCompact={over.autoCompact ?? true} limit={over.limit ?? 100_000} onChange={onChange} />);
  return onChange;
};

describe("the model's own conversation", () => {
  it("shows how big it is now", async () => {
    show(api());
    expect(await screen.findByText(/150K tokens/i)).toBeTruthy();
  });

  it("has a switch and a size limit that are saved with the other settings, not by themselves", async () => {
    const onChange = show(api());
    const box = (await screen.findByLabelText(/tidy up by itself/i)) as HTMLInputElement;
    expect(box.checked).toBe(true);
    await userEvent.click(box);
    expect(onChange).toHaveBeenCalledWith({ autoCompact: false });
    await userEvent.selectOptions(screen.getByLabelText(/when it grows past/i), "200000");
    expect(onChange).toHaveBeenCalledWith({ compactAtTokens: 200_000 });
  });

  it("shows a limit that is not in the list instead of hiding it", async () => {
    show(api(), { limit: 130_000 });
    expect(((await screen.findByLabelText(/when it grows past/i)) as HTMLSelectElement).value).toBe("130000");
  });

  it("tidies up now, and says what happened", async () => {
    const a = api();
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: /tidy up now/i }));
    await waitFor(() => expect(a.compact).toHaveBeenCalledTimes(1));
    expect(await screen.findByText(/wrote notes/i)).toBeTruthy();
  });

  it("starts fresh only after the PIN", async () => {
    const a = api();
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: /start fresh/i }));
    expect(a.clear).not.toHaveBeenCalled();
    expect(screen.getByText(/enter your pin/i)).toBeTruthy();
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    await waitFor(() => expect(a.clear).toHaveBeenCalledWith("123456"));
    expect(await screen.findByText(/started fresh/i)).toBeTruthy();
  });

  it("shows a wrong PIN and does not claim success", async () => {
    const a = api();
    (a.clear as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Incorrect PIN"));
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: /start fresh/i }));
    await typePin("000000");
    await userEvent.click(screen.getByRole("button", { name: /^continue$/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/Incorrect PIN/);
  });

  it("can back out of the PIN step", async () => {
    const a = api();
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: /start fresh/i }));
    await userEvent.click(screen.getByRole("button", { name: /^back$/i }));
    expect(a.clear).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: /start fresh/i })).toBeTruthy();
  });

  it("explains when the model keeps no conversation of its own, and offers nothing to press", async () => {
    show(api(info({ supported: false })));
    expect(await screen.findByText(/does not keep a conversation/i)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /tidy up now/i })).toBeNull();
  });

  it("shows a message when it cannot ask", async () => {
    const a = api();
    (a.compact as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Could not reach Friend. Check the connection."));
    show(a);
    await userEvent.click(await screen.findByRole("button", { name: /tidy up now/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/could not reach friend/i);
  });
});
