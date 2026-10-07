import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Chart, Gauge, Graph, Timeline } from "./charts";
import { CATALOG } from "./objects";

const series = (name: string, values: unknown[]) => ({ name, values });

describe("<Chart>", () => {
  it("draws one line path per series and a legend when there are several", () => {
    const { container } = render(
      <Chart props={{ kind: "line", labels: ["a", "b", "c"], series: [series("cpu", [1, 3, 2]), series("ram", [2, 2, 4])] }} />,
    );
    expect(container.querySelectorAll("path.series-line")).toHaveLength(2);
    expect(screen.getByText("cpu")).toBeTruthy();
    expect(screen.getByText("ram")).toBeTruthy();
  });
  it("draws an area fill for the area kind", () => {
    const { container } = render(<Chart props={{ kind: "area", labels: ["a", "b"], series: [series("s", [1, 2])] }} />);
    expect(container.querySelectorAll("path.series-area")).toHaveLength(1);
  });
  it("draws one rect per value for the bar kind", () => {
    const { container } = render(
      <Chart props={{ kind: "bar", labels: ["a", "b", "c"], series: [series("x", [1, 2, 3]), series("y", [3, 2, 1])] }} />,
    );
    expect(container.querySelectorAll("rect.bar")).toHaveLength(6);
  });
  it("shows an empty message for missing, empty or all-invalid data instead of throwing", () => {
    for (const props of [{}, { series: [] }, { series: [series("s", [])] }, { series: [series("s", ["x", Number.NaN, null])] }, { series: "no", labels: 5 }]) {
      const { container, unmount } = render(<Chart props={props as Record<string, unknown>} />);
      expect(container.textContent).toMatch(/no data/i);
      unmount();
    }
  });
  it("skips non-numeric points but keeps the valid ones", () => {
    const { container } = render(<Chart props={{ kind: "line", series: [series("s", [1, "x", 3, Number.NaN, 5])] }} />);
    expect(container.querySelectorAll("path.series-line")).toHaveLength(1);
    // the three valid points (1, 3, 5) are joined into one continuous line: one M and two L segments
    expect((container.querySelector("path.series-line")!.getAttribute("d") ?? "").match(/L/g)!.length).toBe(2);
  });
  it("truncates a 500-point series to 120 points and 6 series", () => {
    const many = Array.from({ length: 500 }, (_, i) => i);
    const { container } = render(<Chart props={{ kind: "line", series: Array.from({ length: 9 }, (_, i) => series(`s${i}`, many)) }} />);
    const paths = container.querySelectorAll("path.series-line");
    expect(paths).toHaveLength(6);
    expect(paths[0]!.getAttribute("d")!.match(/L/g)).toHaveLength(119);
  });
  it("renders a title when given", () => {
    render(<Chart props={{ title: "Load", series: [series("s", [1, 2])] }} />);
    expect(screen.getByText("Load")).toBeTruthy();
  });
});

describe("<Gauge>", () => {
  it("shows label, value and unit", () => {
    render(<Gauge props={{ label: "CPU", value: 42, unit: "%" }} />);
    expect(screen.getByText("CPU")).toBeTruthy();
    expect(screen.getByText("42")).toBeTruthy();
    expect(screen.getByText("%")).toBeTruthy();
  });
  it("turns amber above 80% and red above 95% of the range", () => {
    const cls = (v: number) => render(<Gauge props={{ label: "x", value: v }} />).container.querySelector(".obj-gauge")!.className;
    expect(cls(50)).not.toMatch(/gauge-(warn|crit)/);
    expect(cls(85)).toMatch(/gauge-warn/);
    expect(cls(97)).toMatch(/gauge-crit/);
  });
  it("respects min and max and survives bad values", () => {
    const { container } = render(<Gauge props={{ label: "T", value: "hot", min: 10, max: "x" }} />);
    expect(container.querySelector(".obj-gauge")).toBeTruthy();
    expect(render(<Gauge props={{}} />).container.querySelector(".obj-gauge")).toBeTruthy();
  });
});

describe("<Timeline>", () => {
  it("lists items in order with their details", () => {
    const { container } = render(
      <Timeline props={{ items: [{ time: "09:00", title: "Stand-up", detail: "Daily" }, { time: "10:30", title: "Review" }] }} />,
    );
    const titles = [...container.querySelectorAll("li strong")].map((e) => e.textContent);
    expect(titles).toEqual(["Stand-up", "Review"]);
    expect(screen.getByText("Daily")).toBeTruthy();
  });
  it("caps at 30 items and tolerates junk", () => {
    const items = Array.from({ length: 50 }, (_, i) => ({ time: String(i), title: `t${i}` }));
    expect(render(<Timeline props={{ items }} />).container.querySelectorAll("li")).toHaveLength(30);
    expect(render(<Timeline props={{ items: [1, null, "x", { title: 5 }] }} />).container).toBeTruthy();
    expect(render(<Timeline props={{}} />).container.textContent).toMatch(/nothing to show/i);
  });
});

describe("<Graph>", () => {
  it("draws a node per id and an edge per valid edge", () => {
    const { container } = render(
      <Graph props={{ nodes: [{ id: "a", label: "API" }, { id: "b" }, { id: "c" }], edges: [{ from: "a", to: "b" }, { from: "b", to: "c", label: "x" }] }} />,
    );
    expect(container.querySelectorAll("circle.node")).toHaveLength(3);
    expect(container.querySelectorAll("path.edge")).toHaveLength(2);
    expect(screen.getByText("API")).toBeTruthy();
  });
  it("skips edges to unknown nodes, self edges and duplicate node ids without crashing", () => {
    const { container } = render(
      <Graph props={{ nodes: [{ id: "a" }, { id: "a" }, { id: "b" }], edges: [{ from: "a", to: "ghost" }, { from: "a", to: "a" }, { from: "a", to: "b" }] }} />,
    );
    expect(container.querySelectorAll("circle.node")).toHaveLength(2);
    expect(container.querySelectorAll("path.edge")).toHaveLength(1);
  });
  it("caps nodes at 40 and edges at 80, truncates long labels", () => {
    const nodes = Array.from({ length: 60 }, (_, i) => ({ id: `n${i}`, label: "a-very-long-label-that-keeps-going" }));
    const edges = Array.from({ length: 200 }, (_, i) => ({ from: `n${i % 40}`, to: `n${(i + 1) % 40}` }));
    const { container } = render(<Graph props={{ nodes, edges }} />);
    expect(container.querySelectorAll("circle.node")).toHaveLength(40);
    expect(container.querySelectorAll("path.edge").length).toBeLessThanOrEqual(80);
    expect(container.querySelector("text.node-label")!.textContent!.length).toBeLessThanOrEqual(19);
  });
  it("shows an empty message with no nodes", () => {
    expect(render(<Graph props={{}} />).container.textContent).toMatch(/nothing to show/i);
  });
});

describe("catalog", () => {
  it("registers every new object type", () => {
    for (const t of ["chart", "gauge", "timeline", "graph"]) expect(CATALOG).toHaveProperty(t);
  });
});
