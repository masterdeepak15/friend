import type { StageCommand } from "@friend/protocol";

const clampPct = (n: number) => Math.min(100, Math.max(0, Math.round(n)));

function used(line: string | undefined): number | null {
  const m = line && /([\d.]+) GB free of ([\d.]+) GB/.exec(line);
  if (!m) return null;
  const free = Number(m[1]);
  const total = Number(m[2]);
  return total > 0 && Number.isFinite(free) ? clampPct(((total - free) / total) * 100) : null;
}

/** The pictures for the device's `system.info` text: placed by the server, so they appear whatever the model does next. */
export function statsScene(text: string): StageCommand[] | null {
  const get = (key: string) => new RegExp(`^${key}: (.+)$`, "m").exec(text)?.[1]?.trim();
  const show = (id: string, type: "gauge" | "stat", props: Record<string, unknown>): StageCommand => ({
    cmd: "show",
    object: { id, type, props, placement: "auto" },
  });
  const out: StageCommand[] = [];

  const load = Number(/^cpu load: (\d+)%$/m.exec(text)?.[1]);
  if (Number.isFinite(load)) out.push(show("stats-cpu", "gauge", { label: "CPU load", value: clampPct(load), unit: "%" }));
  const mem = used(get("memory"));
  if (mem !== null) out.push(show("stats-memory", "gauge", { label: "Memory", value: mem, unit: "%" }));
  const diskLine = get("disk");
  const dsk = used(diskLine);
  if (dsk !== null) out.push(show("stats-disk", "gauge", { label: `Disk ${/\(([^)]+)\)$/.exec(diskLine ?? "")?.[1] ?? ""}`.trim(), value: dsk, unit: "%" }));
  const up = /^([\d.]+) hours$/.exec(get("uptime") ?? "")?.[1];
  if (up) out.push(show("stats-uptime", "stat", { label: "Uptime", value: up, unit: "hours" }));
  const cpu = /^(.*) x(\d+)$/.exec(get("cpu") ?? "");
  if (cpu) out.push(show("stats-cpuinfo", "stat", { label: "CPU", value: cpu[2]!, unit: "cores", delta: cpu[1]!.slice(0, 48) }));

  return out.length ? [{ cmd: "scene", mode: "multi" }, ...out] : null;
}
