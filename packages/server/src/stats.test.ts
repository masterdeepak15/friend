import { StageCommand } from "@friend/protocol";
import { describe, expect, it } from "vitest";
import { statsScene } from "./stats";

const SAMPLE = [
  "platform: win32 10.0.26300 (x64)",
  "host: DEEPAK-PC",
  "user: DEEPAK",
  "cpu: AMD Ryzen 7 5700U with Radeon Graphics x16",
  "cpu load: 37%",
  "memory: 6.0 GB free of 24.0 GB",
  "disk: 120.5 GB free of 476.0 GB (C:\\)",
  "uptime: 14.2 hours",
  "node: v24.21.0",
].join("\n");

const shown = (cmds: ReturnType<typeof statsScene>) => (cmds ?? []).flatMap((c) => (c.cmd === "show" ? [c.object] : []));

describe("statsScene", () => {
  it("turns system info into gauges and numbers on the screen", () => {
    const cmds = statsScene(SAMPLE)!;
    for (const c of cmds) expect(StageCommand.safeParse(c).success, JSON.stringify(c)).toBe(true);
    expect(cmds[0]).toEqual({ cmd: "scene", mode: "multi" });
    const o = shown(cmds);
    expect(o.every((x) => x.id.startsWith("stats-"))).toBe(true);
    expect(o.find((x) => x.id === "stats-cpu")).toMatchObject({ type: "gauge", props: { label: "CPU load", value: 37, unit: "%" } });
    expect(o.find((x) => x.id === "stats-memory")).toMatchObject({ type: "gauge", props: { label: "Memory", value: 75, unit: "%" } }); // 18 of 24 GB used
    expect(o.find((x) => x.id === "stats-disk")).toMatchObject({ type: "gauge", props: { label: "Disk C:\\", value: 75 } }); // 355.5 of 476 GB used
    expect(o.find((x) => x.id === "stats-uptime")).toMatchObject({ type: "stat", props: { label: "Uptime", value: "14.2", unit: "hours" } });
    expect(o.find((x) => x.id === "stats-cpuinfo")).toMatchObject({ type: "stat", props: { label: "CPU", value: "16", unit: "cores" } });
    expect(o.find((x) => x.id === "stats-cpuinfo")!.props.delta).toContain("Ryzen");
  });

  it("shows only what it could read, and nothing at all for something else", () => {
    const some = shown(statsScene("memory: 1.0 GB free of 4.0 GB\nnonsense: 5"));
    expect(some.map((x) => x.id)).toEqual(["stats-memory"]);
    expect(statsScene("nothing useful here")).toBeNull();
    expect(statsScene("")).toBeNull();
  });

  it("keeps every number sensible, even for odd input", () => {
    const o = shown(statsScene("cpu load: 400%\nmemory: 9.0 GB free of 4.0 GB\ndisk: 0.0 GB free of 0.0 GB (/)"));
    for (const x of o) {
      const v = (x.props as { value: unknown }).value;
      if (typeof v === "number") {
        expect(Number.isFinite(v)).toBe(true);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(100);
      }
    }
    expect(o.find((x) => x.id === "stats-disk")).toBeUndefined(); // a disk of size zero tells nothing
  });
});
