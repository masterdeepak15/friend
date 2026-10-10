import { act, cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Group, Tabs } from "./objects";
import { Checklist, Countdown, Gallery, Img, Kv, Markdown, Pdf, Progress, Video, clockText } from "./more";
import { buildSandboxDoc, themeCss } from "./sandbox";

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  document.documentElement.removeAttribute("style");
});

const ID = "a".repeat(32);
const SRC = `/api/media/${ID}`;

describe("markdown", () => {
  it("shows headings, lists, tables and links, and nothing dangerous", () => {
    const { container } = render(<Markdown props={{ title: "Plan", text: "# Big\n\n- one\n\n| a | b |\n|---|---|\n| 1 | 2 |\n\n[site](https://example.com) <script>alert(1)</script> <img src=x onerror=alert(1)>" }} />);
    expect(container.querySelector("h1")?.textContent).toBe("Big");
    expect(container.querySelector("table td")?.textContent).toBe("1");
    expect(container.querySelector("a")?.getAttribute("rel")).toMatch(/noopener/);
    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });
});

describe("progress, checklist, kv", () => {
  it("draws a progress bar clamped to 0..100", () => {
    render(<Progress props={{ label: "Upload", value: 140, detail: "almost" }} />);
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("100");
    expect(screen.getByText("almost")).toBeTruthy();
  });
  it("counts what is done", () => {
    render(<Checklist props={{ title: "Today", items: [{ text: "a", done: true }, { text: "b" }, "c"] }} />);
    expect(screen.getByText("1 of 3 done")).toBeTruthy();
  });
  it("lists key and value pairs", () => {
    const { container } = render(<Kv props={{ title: "Host", rows: [{ key: "OS", value: "Windows" }, { key: "Cores", value: 8 }] }} />);
    expect(container.querySelectorAll("dt")).toHaveLength(2);
    expect(container.querySelectorAll("dd")[1]?.textContent).toBe("8");
  });
});

describe("countdown", () => {
  it("formats the time", () => {
    expect(clockText(3661)).toBe("01:01:01");
    expect(clockText(-5)).toBe("00:00:00");
  });
  it("ticks down and marks the end", () => {
    vi.useFakeTimers();
    render(<Countdown props={{ title: "Tea", seconds: 3 }} />);
    expect(screen.getByRole("timer").textContent).toBe("00:00:03");
    act(() => {
      vi.advanceTimersByTime(3500);
    });
    expect(screen.getByRole("timer").textContent).toBe("00:00:00");
  });
});

describe("pictures, clips and documents", () => {
  it("shows a file the owner approved", () => {
    const { container } = render(<><Img props={{ src: SRC, title: "Cat" }} /><Video props={{ src: SRC }} /><Pdf props={{ src: SRC, title: "Doc" }} /></>);
    expect(container.querySelector("img")?.getAttribute("src")).toBe(SRC);
    expect(container.querySelector("video")?.getAttribute("src")).toBe(SRC);
    expect(container.querySelector("iframe")?.getAttribute("src")).toBe(SRC);
    expect(screen.getByText("Open in a new tab").getAttribute("rel")).toMatch(/noopener/);
  });

  it("refuses any other address, so nothing can be sent to or loaded from the web", () => {
    const { container } = render(
      <>
        <Img props={{ src: "https://evil.example/x.png?leak=secret" }} />
        <Video props={{ src: "//evil.example/x.mp4" }} />
        <Pdf props={{ src: "javascript:alert(1)" }} />
        <Img props={{ src: `${SRC}/../../x` }} />
      </>,
    );
    expect(container.querySelector("img, video, iframe")).toBeNull();
    expect(screen.getAllByText(/not available/)).toHaveLength(4);
  });

  it("steps through a gallery of pictures and clips", async () => {
    const other = `/api/media/${"b".repeat(32)}`;
    const { container } = render(<Gallery props={{ items: [{ src: SRC, caption: "First" }, { src: other, kind: "video", caption: "Second" }, { src: "https://evil/x.png" }] }} />);
    expect(screen.getByText("First")).toBeTruthy();
    expect(screen.getByText("1 / 2")).toBeTruthy(); // the web address was left out
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(container.querySelector("video")?.getAttribute("src")).toBe(other);
    await userEvent.click(screen.getByRole("button", { name: "Next" }));
    expect(container.querySelector("img")?.getAttribute("src")).toBe(SRC);
    await userEvent.click(screen.getByRole("button", { name: "Previous" }));
    expect(screen.getByText("2 / 2")).toBeTruthy();
  });
});

describe("group and tabs", () => {
  const stat = { type: "stat", props: { label: "CPU", value: 42, unit: "%" } };

  it("puts several objects in one", () => {
    render(<Group props={{ title: "Server", items: [stat, { type: "progress", props: { label: "Disk", value: 60 } }, { type: "kv", props: { rows: [{ key: "Up", value: "3d" }] } }] }} />);
    expect(screen.getByText("CPU")).toBeTruthy();
    expect(screen.getByText("Disk")).toBeTruthy();
    expect(screen.getByText("Up")).toBeTruthy();
  });

  it("does not draw a sandbox, another group or something unknown inside", () => {
    const { container } = render(<Group props={{ items: [{ type: "sandbox", props: { html: "<p>x</p>" } }, { type: "group", props: { items: [stat] } }, { type: "nonsense", props: {} }, stat] }} />);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.querySelectorAll(".obj-part")).toHaveLength(1);
  });

  it("switches views", async () => {
    render(<Tabs props={{ tabs: [{ title: "Now", ...stat }, { title: "Later", type: "list", props: { items: ["buy milk"] } }] }} />);
    expect(screen.getByText("CPU")).toBeTruthy();
    await userEvent.click(screen.getByRole("tab", { name: "Later" }));
    expect(screen.getByText("buy milk")).toBeTruthy();
    expect(screen.queryByText("CPU")).toBeNull();
  });
});

describe("the theme for the AI's pages", () => {
  it("hands the screen's colours to a sandbox page as CSS variables", () => {
    document.documentElement.style.setProperty("--accent", "#ff00aa");
    document.documentElement.style.setProperty("--ink", "#eeeeee");
    const css = themeCss();
    expect(css).toContain("--accent:#ff00aa");
    expect(buildSandboxDoc("<p>hi</p>", css)).toContain(":root{");
  });

  it("passes on only plain colour and font values", () => {
    document.documentElement.style.setProperty("--accent", "red;}</style><script>alert(1)</script>");
    document.documentElement.style.setProperty("--ok", "#00ff88");
    const css = themeCss();
    expect(css).not.toContain("script");
    expect(css).not.toContain("--accent");
    expect(css).toContain("--ok:#00ff88");
  });
});
