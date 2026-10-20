import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { NetworkWidget, formatBytes } from "./NetworkWidget";
import { RadarWidget } from "./RadarWidget";
import { SystemWidget } from "./SystemWidget";

afterEach(cleanup);

const at = 1_000_000;
const stats = { cpu: 38, ramUsed: 8e9, ramTotal: 16e9, netDown: 1536, netUp: 0, at };

describe("SystemWidget", () => {
  it("waits quietly until the first reading", () => {
    render(<SystemWidget stats={null} now={at} />);
    expect(screen.getByText(/waiting for data/i)).toBeTruthy();
  });

  it("shows the processor on the gauge and the memory share beside it", () => {
    render(<SystemWidget stats={stats} now={at + 1000} />);
    expect(screen.getByRole("img", { name: /CPU 38%/ })).toBeTruthy();
    expect(screen.getByText(/RAM 50%/)).toBeTruthy();
  });

  it("says when the reading is older than ten seconds", () => {
    render(<SystemWidget stats={stats} now={at + 11_000} />);
    expect(screen.getByText(/stale/i)).toBeTruthy();
  });

  it("copes with a machine that reports no memory", () => {
    render(<SystemWidget stats={{ ...stats, ramTotal: 0, ramUsed: 0 }} now={at} />);
    expect(screen.getByText(/RAM 0%/)).toBeTruthy();
  });
});

describe("formatBytes", () => {
  it("writes sizes the way a person reads them", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(900)).toBe("900 B");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(5_242_880)).toBe("5.0 MB");
    expect(formatBytes(3 * 1024 ** 3)).toBe("3.0 GB");
  });
});

describe("NetworkWidget", () => {
  it("shows the speed down and up", () => {
    render(<NetworkWidget stats={stats} now={at} />);
    expect(screen.getByText(/1\.5 KB\/s/)).toBeTruthy();
    expect(screen.getByText(/0 B\/s/)).toBeTruthy();
  });

  it("says n/a when this PC reports no network counters", () => {
    render(<NetworkWidget stats={{ ...stats, netDown: 0, netUp: 0 }} now={at} />);
    expect(screen.getByText(/n\/a/i)).toBeTruthy();
  });

  it("waits for the first reading", () => {
    render(<NetworkWidget stats={null} now={at} />);
    expect(screen.getByText(/waiting for data/i)).toBeTruthy();
  });
});

describe("RadarWidget", () => {
  const labels = (c: HTMLElement) => [...c.querySelectorAll("[data-blip]")].map((b) => b.textContent);
  const dim = (c: HTMLElement) => [...c.querySelectorAll("[data-blip][data-dim]")].map((b) => b.textContent);

  it("always shows this screen, and the PC and the voice as they really are", () => {
    const { container } = render(<RadarWidget deviceOnline voiceAvailable />);
    expect(labels(container)).toEqual(["This screen", "PC", "Voice"]);
    expect(dim(container)).toEqual([]);
  });

  it("dims a source that is offline instead of leaving it out or inventing it", () => {
    const { container } = render(<RadarWidget deviceOnline={false} voiceAvailable={false} />);
    expect(labels(container)).toEqual(["This screen", "PC", "Voice"]);
    expect(dim(container)).toEqual(["PC", "Voice"]);
  });
});
