import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { HouseholdPanel } from "./HouseholdPanel";
import type { HouseholdApi, HouseholdOverview } from "./householdApi";
import { reduce, initialState } from "../store";

afterEach(cleanup);

function setup(over: Partial<HouseholdOverview> = {}) {
  let overview: HouseholdOverview = { people: [], max: 8, ownerEnrolled: true, enrolling: null, ...over };
  let count = 0;
  const api: HouseholdApi = {
    overview: vi.fn(async () => overview),
    begin: vi.fn(async (name: string) => ({ name: name.trim(), enrolled: false, samples: 0, min: 3, max: 8 })),
    recording: {
      state: vi.fn(async () => ({ enrolled: false, samples: count, min: 3, max: 8 })),
      sample: vi.fn(async () => ({ count: ++count, note: null })),
      finish: vi.fn(async () => {
        overview = { ...overview, people: [...overview.people, { id: 9, name: "Priya", samples: count, createdAt: 1 }] };
        return { samples: count };
      }),
      cancel: vi.fn(async () => {}),
      remove: vi.fn(async () => {}),
    },
    removePerson: vi.fn(async () => {}),
  };
  const recorder = { start: vi.fn(async () => {}), stop: vi.fn(async () => new Blob(["audio"], { type: "audio/webm" })), cancel: vi.fn() };
  const onClose = vi.fn();
  render(<HouseholdPanel api={api} createRecorder={() => recorder} onClose={onClose} />);
  return { api, onClose };
}
const typePin = async (pin: string) => {
  for (const d of pin) await userEvent.click(screen.getByRole("button", { name: d }));
};

describe("<HouseholdPanel>", () => {
  it("says to teach the owner's voice first when it is not saved yet", async () => {
    setup({ ownerEnrolled: false });
    expect(await screen.findByText(/first teach friend your own voice/i)).toBeTruthy();
    expect(screen.queryByPlaceholderText(/name/i)).toBeNull();
  });

  it("lists the people Friend knows", async () => {
    setup({ people: [{ id: 1, name: "Priya", samples: 5, createdAt: 1 }, { id: 2, name: "Arjun", samples: 5, createdAt: 1 }] });
    expect(await screen.findByText("Priya")).toBeTruthy();
    expect(screen.getByText("Arjun")).toBeTruthy();
  });

  it("adds a person: the name, then the recording screen for that person, then back to the list", async () => {
    const { api } = setup();
    await userEvent.type(await screen.findByPlaceholderText(/name/i), "  Priya ");
    await userEvent.click(screen.getByRole("button", { name: /record their voice/i }));
    expect(api.begin).toHaveBeenCalledWith("Priya");
    expect(await screen.findByText("Teach Friend Priya's voice")).toBeTruthy();
    for (let i = 0; i < 3; i++) {
      await userEvent.click(await screen.findByRole("button", { name: /^record$/i }));
      await userEvent.click(await screen.findByRole("button", { name: /^stop$/i }));
      await waitFor(() => expect(screen.getByRole("button", { name: /^record$/i })).toBeTruthy());
    }
    await userEvent.click(screen.getByRole("button", { name: /save priya's voice/i }));
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^save$/i }));
    expect(api.recording.finish).toHaveBeenCalledWith("123456");
    expect(await screen.findByText(/Priya's voice is saved/)).toBeTruthy();
    await userEvent.click(screen.getByRole("button", { name: /^done$/i }));
    expect(await screen.findByText("Priya")).toBeTruthy(); // she is now in the list
  });

  it("shows a refused name (already saved) and stays on the list", async () => {
    const { api } = setup();
    (api.begin as ReturnType<typeof vi.fn>).mockRejectedValueOnce(new Error("Priya is already saved."));
    await userEvent.type(await screen.findByPlaceholderText(/name/i), "Priya");
    await userEvent.click(screen.getByRole("button", { name: /record their voice/i }));
    expect((await screen.findByRole("alert")).textContent).toMatch(/already saved/);
  });

  it("removes a person only after the PIN", async () => {
    const { api } = setup({ people: [{ id: 4, name: "Arjun", samples: 5, createdAt: 1 }] });
    await userEvent.click(await screen.findByRole("button", { name: /remove arjun/i }));
    const remove = screen.getByRole("button", { name: /^remove$/i }) as HTMLButtonElement;
    expect(remove.disabled).toBe(true);
    await typePin("123456");
    await userEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(api.removePerson).toHaveBeenCalledWith(4, "123456");
  });

  it("does not offer a ninth person", async () => {
    const people = Array.from({ length: 8 }, (_, i) => ({ id: i + 1, name: `P${i}`, samples: 5, createdAt: 1 }));
    setup({ people });
    await screen.findByText("P0");
    expect(screen.queryByPlaceholderText(/name/i)).toBeNull();
  });
});

describe("captions for a person of the household", () => {
  it("names who is speaking", () => {
    expect(reduce(initialState, { type: "voice.heard", text: "what's the weather", trust: "member", speaker: "Priya" }).captions).toBe("Priya: what's the weather");
  });
});
