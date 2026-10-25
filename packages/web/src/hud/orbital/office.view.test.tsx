import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { HudView, OfficeWorkerView } from "@friend/protocol";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialState, type OfficeState, type StageViewState } from "../../store";
import { OrbitalHud } from "./OrbitalHud";

afterEach(cleanup);

const launcher: HudView["launcher"] = [
  { id: "chat", label: "Chat", icon: "C", action: { type: "panel", value: "chat" } },
  { id: "tasks", label: "Tasks", icon: "T", action: { type: "panel", value: "tasks" } },
];
const ALL_ON = { system: true, voice: true, network: true, feed: true, radar: true, tickets: true, approval: true };
const hudOf = (over: Partial<HudView> = {}): HudView => ({ terminalLabel: "T", clock: { hour12: true, seconds: false, locale: "" }, launcher, animations: "full", layout: "orbital", density: "standard", widgets: ALL_ON, ...over });
const worker = (name: string, over: Partial<OfficeWorkerView> = {}): OfficeWorkerView => ({ id: name.toLowerCase(), name, roleId: "scribe", title: "Scribe", capabilities: "", managerId: null, projectId: "site", status: "idle", ticketId: null, detail: "", tokens: 0, budget: null, startedAt: null, ...over });
const office = (over: Partial<OfficeState> = {}): OfficeState => ({ ...initialState.office, enabled: true, ...over });

function mount(over: Partial<HudView> = {}, state: Partial<StageViewState> = {}, extra: { send?: (m: never) => void; onHire?: () => void; usage?: number | null } = {}) {
  const hud = hudOf(over);
  return render(<OrbitalHud hud={hud} state={{ ...initialState, connection: "open", hud, ...state }} viewport={{ w: 1920, h: 1080 }} usage={extra.usage === undefined ? 17 : extra.usage} send={(extra.send ?? (() => {})) as never} {...(extra.onHire ? { onHire: extra.onHire } : {})} onLaunch={() => {}} onExpand={() => {}} />);
}
const nodes = (c: HTMLElement) => [...c.querySelectorAll(".ob-node")];

describe("the orbit with the office on", () => {
  it("shows the workers instead of the launcher, and a hire node", () => {
    const { container } = mount({}, { office: office({ workers: [worker("Ada"), worker("Bob")] }) });
    expect(nodes(container)).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Ada, idle" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Bob, idle" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /hire a worker/i })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Chat" })).toBeNull();
  });

  it("keeps the launcher and adds the hire node while no one is hired", () => {
    const { container } = mount({}, { office: office() });
    expect(nodes(container)).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Chat" })).toBeTruthy();
    expect(screen.getByRole("button", { name: /hire a worker/i })).toBeTruthy();
  });

  it("changes nothing while the office is off", () => {
    const { container } = mount({}, { office: office({ enabled: false, workers: [worker("Ada")] }) });
    expect(nodes(container)).toHaveLength(2);
    expect(screen.getByRole("button", { name: "Chat" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /hire a worker/i })).toBeNull();
  });

  it("opens Settings, Office from the hire node", () => {
    const onHire = vi.fn();
    mount({}, { office: office({ workers: [worker("Ada")] }) }, { onHire });
    fireEvent.click(screen.getByRole("button", { name: /hire a worker/i }));
    expect(onHire).toHaveBeenCalledTimes(1);
  });

  it("makes a waiting worker's node and link orange", () => {
    const { container } = mount({}, { office: office({ workers: [worker("Ada", { status: "waiting", detail: "needs approval" }), worker("Bob", { status: "running" })] }) });
    expect(nodes(container)[0]!.getAttribute("data-tone")).toBe("orange");
    expect(nodes(container)[1]!.getAttribute("data-tone")).toBe("green");
    expect(container.querySelectorAll('.ob-link[data-tone="orange"]')).toHaveLength(1);
  });

  it("shows the real tickets, budgets and worker feed in the instruments", () => {
    const o = office({
      workers: [worker("Ada", { tokens: 250, budget: 1000 })],
      tickets: [
        { id: 1, projectId: "site", title: "Fix it", status: "doing", workerId: "ada" },
        { id: 2, projectId: "site", title: "Done one", status: "done", workerId: "ada" },
      ],
      feed: { ada: [{ at: 1, kind: "tool", text: "Write a.txt" }] },
    });
    const { container } = mount({ density: "full" }, { office: o });
    const text = (id: string) => container.querySelector(`[data-widget="${id}"]`)!.textContent ?? "";
    expect(text("tickets")).toContain("TICKETS · site");
    expect(text("tickets")).toContain("DONE 1");
    expect(text("tickets")).toContain("DOING 1");
    expect(text("budget")).toContain("ADA 25%");
    expect(text("feed")).toContain("ADA");
    expect(text("feed")).toContain("Write a.txt");
  });

  it("lights the usage ring from the real five-hour window, with the time it resets", () => {
    const resetsAt = Math.floor((Date.now() + (2 * 60 + 10) * 60_000) / 1000);
    const { container } = mount({}, { office: office({ quota: { fiveHour: { utilization: 0.42, resetsAt }, sevenDay: null } }) });
    expect(container.querySelectorAll('[data-seg][data-on="true"]')).toHaveLength(25); // 42% of 60 segments
    expect(container.querySelector('[data-widget="usage"]')!.textContent).toMatch(/USAGE 42%.*RESET 2H (9|10)M/);
  });

  it("keeps today's usage when no window is known", () => {
    const { container } = mount({}, { office: office() });
    expect(container.querySelector('[data-widget="usage"]')!.textContent).toBe("USAGE 17%");
  });

  it("shows the sample data, not the real office, while the preview is on", () => {
    const { container } = mount({ preview: true }, { office: office({ workers: [worker("Ada")] }) });
    expect(screen.queryByRole("button", { name: /^Ada/ })).toBeNull();
    expect(container.textContent).toContain("SAMPLE DATA");
  });
});

describe("the name in the middle", () => {
  const label = (c: HTMLElement) => c.querySelector(".ob-orb-label small")!.textContent;
  it("says what the office is doing while Friend himself is idle", () => {
    expect(label(mount({}, { office: office({ workers: [worker("Ada", { status: "running" }), worker("Bob", { status: "starting" })] }) }).container)).toBe("working · 2");
    cleanup();
    expect(label(mount({}, { office: office({ workers: [worker("Ada", { status: "waiting" }), worker("Bob", { status: "running" })] }) }).container)).toBe("needs you");
    cleanup();
    expect(label(mount({}, { office: office({ workers: [worker("Ada")] }) }).container)).toBe("idle");
  });

  it("keeps Friend''s own state when he is busy, and ignores the office while it is off", () => {
    expect(label(mount({}, { voice: { ...initialState.voice, mode: "speaking" }, office: office({ workers: [worker("Ada", { status: "running" })] }) }).container)).toBe("speaking");
    cleanup();
    expect(label(mount({}, { office: office({ enabled: false, workers: [worker("Ada", { status: "running" })] }) }).container)).toBe("idle");
  });
});

describe("the activity instrument opened large", () => {
  const feedState = () => office({ workers: [worker("Ada", { status: "running" })], feed: { ada: [{ at: 1, kind: "tool", text: "Write a.txt" }, { at: 2, kind: "result", text: "Done." }] } });

  it("shows what the workers did, even when there has been no conversation yet", () => {
    const { container } = mount({ density: "full" }, { office: feedState() });
    fireEvent.click(container.querySelector('[data-widget="feed"]')!);
    const d = screen.getByRole("dialog", { name: /activity/i });
    expect(d.textContent).toContain("ADA");
    expect(d.textContent).toContain("Write a.txt");
    expect(d.textContent).toContain("Done.");
    expect(d.textContent).not.toMatch(/nothing yet/i);
  });

  it("shows the workers' lines before the conversation, and says so when there is nothing at all", () => {
    const { container } = mount({ density: "full" }, { office: feedState(), chat: [{ role: "assistant", text: "Ada is on it." }] });
    fireEvent.click(container.querySelector('[data-widget="feed"]')!);
    const d = screen.getByRole("dialog", { name: /activity/i });
    expect(d.textContent!.indexOf("Write a.txt")).toBeLessThan(d.textContent!.indexOf("Ada is on it."));
    cleanup();
    const empty = mount({ density: "full" });
    fireEvent.click(empty.container.querySelector('[data-widget="feed"]')!);
    expect(screen.getByRole("dialog", { name: /activity/i }).textContent).toMatch(/nothing yet/i);
  });
});

describe("a worker opened on the screen", () => {
  const busy = () => office({ workers: [worker("Ada", { status: "running", detail: "Write a.txt", tokens: 250, budget: 1000 })], feed: { ada: [{ at: 1, kind: "tool", text: "Write a.txt" }, { at: 2, kind: "text", text: "Almost done" }] } });

  it("opens a dialog named after the worker, with its status, tokens and feed", () => {
    mount({}, { office: busy() });
    fireEvent.click(screen.getByRole("button", { name: /^Ada/ }));
    const d = screen.getByRole("dialog", { name: "Ada" });
    expect(d.textContent).toContain("running");
    expect(d.textContent).toContain("250");
    expect(d.textContent).toContain("1000");
    const lines = [...d.querySelectorAll("[data-feed-line]")].map((e) => e.textContent);
    expect(lines).toEqual(["Write a.txt", "Almost done"]);
  });

  it("stops the worker", () => {
    const send = vi.fn();
    mount({}, { office: busy() }, { send });
    fireEvent.click(screen.getByRole("button", { name: /^Ada/ }));
    fireEvent.click(screen.getByRole("button", { name: /stop/i }));
    expect(send).toHaveBeenCalledWith({ type: "office.stop", workerId: "ada" });
  });

  it("removes the worker only after a second click", () => {
    const send = vi.fn();
    mount({}, { office: busy() }, { send });
    fireEvent.click(screen.getByRole("button", { name: /^Ada/ }));
    fireEvent.click(screen.getByRole("button", { name: /^remove$/i }));
    expect(send).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /confirm remove/i }));
    expect(send).toHaveBeenCalledWith({ type: "office.fire", workerId: "ada" });
  });

  it("says something to the worker, and clears the box", () => {
    const send = vi.fn();
    mount({}, { office: busy() }, { send });
    fireEvent.click(screen.getByRole("button", { name: /^Ada/ }));
    const box = screen.getByRole("textbox", { name: /say to ada/i }) as HTMLInputElement;
    fireEvent.change(box, { target: { value: "use tabs" } });
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(send).toHaveBeenCalledWith({ type: "office.say", workerId: "ada", text: "use tabs" });
    expect(box.value).toBe("");
    fireEvent.click(screen.getByRole("button", { name: /^send$/i }));
    expect(send).toHaveBeenCalledTimes(1); // an empty box sends nothing
  });

  it("closes with the close mark, and when the worker is gone", () => {
    const { rerender } = mount({}, { office: busy() });
    fireEvent.click(screen.getByRole("button", { name: /^Ada/ }));
    fireEvent.click(screen.getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Ada" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /^Ada/ }));
    const hud = hudOf();
    rerender(<OrbitalHud hud={hud} state={{ ...initialState, connection: "open", hud, office: office() }} viewport={{ w: 1920, h: 1080 }} onLaunch={() => {}} onExpand={() => {}} />);
    expect(screen.queryByRole("dialog", { name: "Ada" })).toBeNull();
  });
});

describe("the team tree", () => {
  const team = () => office({ workers: [worker("Lena", { title: "Tech lead", status: "running", detail: "Planning" }), worker("Ben", { title: "Developer", managerId: "lena" }), worker("Cy", { title: "Tester", managerId: "lena", status: "waiting" })] });
  const dialog = () => screen.getByRole("dialog", { name: /office team/i });

  it("opens from a Team button and says who reports to whom, Friend at the top", async () => {
    mount({}, { office: team(), assistantName: "Maya" });
    fireEvent.click(screen.getByRole("button", { name: /^team/i }));
    const lines = [...within(dialog()).getByRole("list", { name: /who reports to whom/i }).querySelectorAll("li")].map((l) => l.textContent);
    expect(lines).toEqual(["Lena reports to Maya", "Ben reports to Lena", "Cy reports to Lena"]);
  });

  it("draws the team on a canvas of Jarvis cards: the assistant and every worker", async () => {
    mount({}, { office: team(), assistantName: "Maya" });
    fireEvent.click(screen.getByRole("button", { name: /^team/i }));
    expect(await within(dialog()).findByText("MAYA", {}, { timeout: 8000 })).toBeTruthy(); // the library is fetched when the team opens
    for (const n of ["Lena", "Ben", "Cy"]) expect(within(dialog()).getByText(n)).toBeTruthy();
    expect(within(dialog()).getByText("Tech lead")).toBeTruthy();
  }, 20_000);

  it("has a card for each worker with the job and what it is doing, and a waiting one is orange", async () => {
    mount({}, { office: team() });
    fireEvent.click(screen.getByRole("button", { name: /^team/i }));
    const lena = await within(dialog()).findByRole("button", { name: /^Lena,/ }, { timeout: 8000 });
    expect(lena.textContent).toContain("Tech lead");
    expect(lena.getAttribute("aria-label")).toContain("Planning");
    expect(within(dialog()).getByRole("button", { name: /^Cy,/ }).getAttribute("data-status")).toBe("waiting");
  }, 20_000);

  it("opens a worker from its card", async () => {
    mount({}, { office: team() });
    fireEvent.click(screen.getByRole("button", { name: /^team/i }));
    fireEvent.click(await within(dialog()).findByRole("button", { name: /^Ben,/ }, { timeout: 8000 }));
    expect(screen.getByRole("dialog", { name: "Ben" })).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: /office team/i })).toBeNull();
  }, 20_000);

  it("fills each card with its rows: job, what it is doing, who it reports to and its tokens", async () => {
    mount({}, { office: team(), assistantName: "Maya" });
    fireEvent.click(screen.getByRole("button", { name: /^team/i }));
    const ben = await within(dialog()).findByRole("button", { name: /^Ben,/ }, { timeout: 8000 });
    expect(ben.textContent).toMatch(/JOB.*Developer/);
    expect(ben.textContent).toMatch(/DOING/);
    expect(ben.textContent).toMatch(/TOKENS/);
    const css = readFileSync(join(process.cwd(), "src/hud/orbital/orbital.css"), "utf8");
    expect(css).toMatch(/\.ob-cnode > \* \{[^}]*width: 100%[^}]*height: 100%/); // the card, and its rows, take the node's whole size
  }, 20_000);

  it("has no Team button until someone is hired, or while the office is off", () => {
    mount({}, { office: office() });
    expect(screen.queryByRole("button", { name: /^team/i })).toBeNull();
    cleanup();
    mount({}, { office: { ...team(), enabled: false } });
    expect(screen.queryByRole("button", { name: /^team/i })).toBeNull();
  });
});