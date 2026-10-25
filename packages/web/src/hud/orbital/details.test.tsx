import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { initialState } from "../../store";
import { DeviceDetails, NetworkDetails, SystemDetails, TicketDetails, VoiceDetails } from "./Details";

const stats = { cpu: 42.4, ramUsed: 6 * 2 ** 30, ramTotal: 16 * 2 ** 30, netDown: 2048, netUp: 512, at: Date.now() };
const voice = { mode: "idle" as const, level: 0, available: true, enrolled: true };

describe("what opens when an instrument is clicked says what the figures mean", () => {
  it("system: the processor and the memory in numbers, the free memory, how fresh the reading is, and a verdict", () => {
    render(<SystemDetails stats={stats} cpuHist={[10, 20, 42]} ramHist={[35, 36, 37]} />);
    expect(screen.getByText("Processor now").nextSibling!.textContent).toBe("42%");
    expect(screen.getByText("Memory now").nextSibling!.textContent).toMatch(/38%.*6\.0 GB of 16\.0 GB/);
    expect(screen.getByText("Memory free").nextSibling!.textContent).toBe("10.0 GB");
    expect(screen.getByText("Last reading").nextSibling!.textContent).toBe("just now");
    expect(screen.getByText(/Light load/)).toBeTruthy();
  });

  it("system: warns when the PC is heavily loaded, and says when the reading is stale", () => {
    render(<SystemDetails stats={{ ...stats, cpu: 95, at: Date.now() - 60_000 }} cpuHist={[]} ramHist={[]} />);
    expect(screen.getByText(/heavy load/i)).toBeTruthy();
    expect(screen.getByText("Last reading").nextSibling!.textContent).toMatch(/stale/);
  });

  it("system and network: say so when there is no reading yet", () => {
    render(<SystemDetails stats={null} cpuHist={[]} ramHist={[]} />);
    render(<NetworkDetails stats={null} down={[]} up={[]} />);
    expect(screen.getAllByText(/Waiting for the first reading/)).toHaveLength(2);
  });

  it("network: the speeds now, the fastest seen from the kept readings, and what a busy line means", () => {
    render(<NetworkDetails stats={stats} down={[1024, 4096, 2048]} up={[100, 512]} />);
    expect(screen.getByText("Download now").nextSibling!.textContent).toBe("2.0 KB/s");
    expect(screen.getByText("Fastest download seen").nextSibling!.textContent).toBe("4.0 KB/s");
    expect(screen.getByText("Fastest upload seen").nextSibling!.textContent).toBe("512 B/s");
    expect(screen.getByText(/everything on this PC/)).toBeTruthy();
  });

  it("network: n/a, not a flat zero, when the PC reports nothing", () => {
    render(<NetworkDetails stats={{ ...stats, netDown: 0, netUp: 0 }} down={[]} up={[]} />);
    expect(screen.getByText("Download now").nextSibling!.textContent).toBe("n/a");
    expect(screen.getByText(/does not report network speed/)).toBeTruthy();
  });

  it("voice: what it is doing, whether voice is set up, what you last said, and how to talk", () => {
    render(<VoiceDetails voice={{ ...voice, mode: "listening", level: 0.4 }} lastHeard="what is the weather" />);
    expect(screen.getByText("Doing now").nextSibling!.textContent).toBe("Listening to you");
    expect(screen.getByText("Sound level").nextSibling!.textContent).toBe("40%");
    expect(screen.getByText("You last said").nextSibling!.textContent).toBe("what is the weather");
    expect(screen.getByText(/Hold Space/)).toBeTruthy();
  });

  it("voice: tells you how to set it up when it is not", () => {
    render(<VoiceDetails voice={{ ...voice, available: false }} lastHeard={null} />);
    expect(screen.getByText("Voice on this PC").nextSibling!.textContent).toBe("not set up");
    expect(screen.getByText(/friend voice setup/)).toBeTruthy();
    expect(screen.queryByText("You last said")).toBeNull();
  });

  it("devices: each one online or offline, with what it is for and what offline means", () => {
    render(<DeviceDetails deviceOnline={false} voiceAvailable={true} />);
    expect(screen.getByText("PC agent").nextSibling!.textContent).toBe("offline");
    expect(screen.getByText(/cannot run commands or read files/)).toBeTruthy();
    expect(screen.getByText("Voice").nextSibling!.textContent).toBe("online");
    expect(screen.getByText(/You are looking at it/)).toBeTruthy();
  });

  it("tickets: the counts, and the newest tickets with their status and worker; or why there are none", () => {
    const office = {
      ...initialState.office,
      enabled: true,
      workers: [{ id: "w1", name: "Ada" }] as never,
      tickets: [
        { id: 1, projectId: "p", title: "Write docs", status: "done", workerId: "w1" },
        { id: 2, projectId: "p", title: "Fix login", status: "review", workerId: "w1" },
        { id: 3, projectId: "p", title: "Add tests", status: "todo", workerId: null },
      ] as never,
    };
    render(<TicketDetails office={office} />);
    expect(screen.getByText("Done").nextSibling!.textContent).toBe("1");
    expect(screen.getByText("Waiting for review").nextSibling!.textContent).toBe("1");
    expect(screen.getByText("#2 · Fix login · review · Ada")).toBeTruthy();
    expect(screen.getByText("#3 · Add tests · todo · nobody yet")).toBeTruthy();
  });

  it("tickets: says the Office is off, or that there are none yet", () => {
    render(<TicketDetails office={{ ...initialState.office, enabled: false }} />);
    expect(screen.getByText(/Office is switched off/)).toBeTruthy();
    render(<TicketDetails office={{ ...initialState.office, enabled: true, tickets: [] }} />);
    expect(screen.getByText(/No tickets yet/)).toBeTruthy();
  });
});
