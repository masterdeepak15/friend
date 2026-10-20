import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ArcGauge, Frame, HexCells, HexNode, HudDefs, LinkLine, PulseLine, Radar, Rings, SegmentedRing, Spectrum } from "./kit";

afterEach(cleanup);

const css = readFileSync(join(process.cwd(), "src/hud/orbital/orbital.css"), "utf8");

describe("Frame", () => {
  it("draws its title and content in the chosen shape and tone", () => {
    render(
      <Frame variant="octagon" tone="orange" title="Approval" running>
        <p>npm install</p>
      </Frame>,
    );
    const frame = screen.getByText("npm install").closest(".ob-frame")!;
    expect(frame.className).toContain("ob-v-octagon");
    expect(frame.getAttribute("data-tone")).toBe("orange");
    expect(frame.hasAttribute("data-running")).toBe(true);
    expect(screen.getByText("Approval")).toBeTruthy();
  });

  it("defaults to a cyan chamfered frame with no running light", () => {
    render(<Frame>x</Frame>);
    const frame = screen.getByText("x").closest(".ob-frame")!;
    expect(frame.className).toContain("ob-v-chamfer");
    expect(frame.getAttribute("data-tone")).toBe("cyan");
    expect(frame.hasAttribute("data-running")).toBe(false);
  });
});

describe("ArcGauge", () => {
  it("clamps its value to 0..100 and says it in words", () => {
    const { container, rerender } = render(<ArcGauge value={-5} label="CPU" />);
    expect(container.querySelector("svg")!.getAttribute("data-value")).toBe("0");
    rerender(<ArcGauge value={500} label="CPU" />);
    expect(container.querySelector("svg")!.getAttribute("data-value")).toBe("100");
    expect(screen.getByRole("img", { name: /CPU 100%/ })).toBeTruthy();
  });

  it("draws an inner arc only when asked", () => {
    const { container, rerender } = render(<ArcGauge value={40} />);
    expect(container.querySelectorAll("[data-arc]")).toHaveLength(1);
    rerender(<ArcGauge value={40} inner={60} />);
    expect(container.querySelectorAll("[data-arc]")).toHaveLength(2);
  });
});

describe("Spectrum", () => {
  it("draws one bar per level, and nothing for no levels", () => {
    const { container, rerender } = render(<Spectrum levels={[0.2, 1, 0.5]} />);
    expect(container.querySelectorAll("rect.ob-eq")).toHaveLength(3);
    expect(container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    rerender(<Spectrum levels={[]} />);
    expect(container.querySelectorAll("rect.ob-eq")).toHaveLength(0);
  });
});

describe("Radar", () => {
  it("draws a blip per source and marks a dim one", () => {
    const { container } = render(<Radar blips={[{ angle: 40, distance: 0.5, label: "PC" }, { angle: 200, distance: 0.8, label: "Voice", dim: true }]} />);
    expect(container.querySelectorAll("[data-blip]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-dim]")).toHaveLength(1);
    expect(screen.getByRole("img", { name: /PC.*Voice/ })).toBeTruthy();
  });

  it("copes with no blips", () => {
    const { container } = render(<Radar blips={[]} />);
    expect(container.querySelectorAll("[data-blip]")).toHaveLength(0);
  });
});

describe("HexCells", () => {
  it("draws a cell per ticket, coloured by status, and an empty shape for none", () => {
    const { container, rerender } = render(<HexCells cells={[{ status: "done" }, { status: "doing" }, { status: "todo" }]} />);
    expect(container.querySelectorAll("[data-status]")).toHaveLength(3);
    rerender(<HexCells cells={[]} />);
    expect(container.querySelectorAll("[data-status]")).toHaveLength(0);
  });
});

describe("Rings", () => {
  it("draws a track and a value per ring, clamped", () => {
    const { container } = render(<Rings rings={[{ value: 42 }, { value: 900, tone: "green" }]} />);
    expect(container.querySelectorAll("[data-ring]")).toHaveLength(2);
    expect(container.querySelectorAll("[data-ring='1']")[0]!.getAttribute("data-value")).toBe("100");
  });
});

describe("SegmentedRing", () => {
  it("fills 25 of its 60 segments at 42%", () => {
    const { container } = render(<SegmentedRing value={42} />);
    expect(container.querySelectorAll("[data-seg]")).toHaveLength(60);
    expect(container.querySelectorAll("[data-seg][data-on='true']")).toHaveLength(25);
  });

  it("is full above 100 and empty below 0", () => {
    const { container, rerender } = render(<SegmentedRing value={150} />);
    expect(container.querySelectorAll("[data-seg][data-on='true']")).toHaveLength(60);
    rerender(<SegmentedRing value={-1} />);
    expect(container.querySelectorAll("[data-seg][data-on='true']")).toHaveLength(0);
  });
});

describe("HexNode", () => {
  it("is a button with a name, and runs, waits or idles in its own tone", () => {
    const onClick = vi.fn();
    const { rerender } = render(<HexNode label="CODE" detail="Hero.tsx" status="running" onClick={onClick} />);
    const b = screen.getByRole("button", { name: "CODE, Hero.tsx" });
    expect(b.getAttribute("data-tone")).toBe("green");
    fireEvent.click(b);
    expect(onClick).toHaveBeenCalledOnce();
    rerender(<HexNode label="REV" status="waiting" />);
    expect(screen.getByRole("button", { name: "REV" }).getAttribute("data-tone")).toBe("orange");
    rerender(<HexNode label="Chat" glyph="C" />);
    expect(screen.getByRole("button", { name: "Chat" }).textContent).toBe("C");
    rerender(<HexNode label="ARCH" status="idle" />);
    expect(screen.getByRole("button", { name: "ARCH" }).getAttribute("data-tone")).toBe("cyan");
  });
});

describe("the decorative pieces", () => {
  it("are hidden from screen readers", () => {
    const { container } = render(
      <svg>
        <LinkLine x1={0} y1={0} x2={10} y2={10} />
      </svg>,
    );
    expect(container.querySelector("line")!.getAttribute("class")).toContain("ob-link");
    const pulse = render(<PulseLine />);
    expect(pulse.container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
    const defs = render(<HudDefs />);
    expect(defs.container.querySelector("svg")!.getAttribute("aria-hidden")).toBe("true");
  });
});

describe("the motion rules in the stylesheet", () => {
  it("defines every loop", () => {
    for (const name of ["spin", "flow", "run", "pulse", "eq", "ecg", "ping", "breathe", "blink"]) expect(css, name).toMatch(new RegExp(`@keyframes ob-${name}\\b`));
  });

  it("stops every loop when animations are off, keeps only the gentle ones when reduced, and obeys the system setting", () => {
    expect(css).toContain('[data-hud-anim="off"]');
    expect(css).toContain('[data-hud-anim="reduced"]');
    expect(css).toContain("prefers-reduced-motion: reduce");
    expect(css).toContain("animation-play-state: paused");
  });
});
