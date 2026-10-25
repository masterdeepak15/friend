import type { JarvisNode } from "@friend/protocol";
import type { HudStats, VoiceMode } from "../../store";
import { formatBytes } from "./widgets/NetworkWidget";

/**
 * The live instruments of the home screen as Jarvis components: data-only trees that the same checked renderer draws as the
 * assistant's own pictures. Nothing here is code; each is built from the readings the screen already has.
 */

const pct = (n: number): number => Math.max(0, Math.min(100, Math.round(n)));
const frame = (title: string, kids: JarvisNode["kids"], color = "cyan"): JarvisNode => ({ c: "JHudFrameCard", p: { title, color, showStatusDot: true, width: "100%" }, kids });

/** The same instrument without its frame, for a dialog that has a frame and a title of its own. */
export const unframed = (n: JarvisNode): JarvisNode => (n.c === "JHudFrameCard" ? { c: "Column", p: { gap: 10 }, ...(n.kids ? { kids: n.kids } : {}) } : n);
const row = (label: string, value: string, bar?: number, state?: "active" | "warning" | "error" | "success"): JarvisNode => ({ c: "JDataRow", p: { label, value, ...(bar !== undefined ? { barPercent: pct(bar) } : {}), ...(state ? { state } : {}) } });

export interface FeedItem {
  text: string;
  tone: "green" | "orange" | "plain";
}

export function systemTree(stats: HudStats | null, detail = false): JarvisNode {
  const cpu = stats ? pct(stats.cpu) : 0;
  const ram = stats && stats.ramTotal > 0 ? pct((100 * stats.ramUsed) / stats.ramTotal) : 0;
  return frame("System", [
    {
      c: "Row",
      p: { gap: 12 },
      kids: [
        { c: "JGaugeChart", p: { value: cpu, min: 0, max: 100, size: detail ? "190px" : "120px", label: "CPU", displayValue: `${cpu}%`, showNeedle: false, showTicks: false, showMinMax: false } },
        {
          c: "Column",
          p: { gap: 6 },
          kids: stats ? [row("CPU", `${cpu}%`, cpu, cpu > 85 ? "warning" : undefined), row("RAM", `${ram}%`, ram, ram > 90 ? "warning" : undefined), ...(detail ? [row("RAM USED", formatBytes(stats.ramUsed)), row("RAM TOTAL", formatBytes(stats.ramTotal))] : [])] : ["Waiting for data"],
        },
      ],
    },
  ]);
}

export function voiceTree(level: number, mode: VoiceMode): JarvisNode {
  const live = mode !== "idle" || level > 0.05;
  return frame("Voice", [
    { c: "JWaveform", p: { barCount: 28, height: "48px", active: live } },
    { c: "JStatusPill", p: { state: live ? "active" : "success" }, kids: [live ? String(mode) : "quiet"] },
  ]);
}

export function networkTree(stats: HudStats | null, history: number[]): JarvisNode {
  const none = !!stats && stats.netDown === 0 && stats.netUp === 0;
  return frame("Network", [
    {
      c: "Row",
      p: { gap: 12 },
      kids: [
        { c: "JSparkline", p: { data: history.length > 1 ? history : [0, 0], showArea: true, height: "40px", width: "130px" } },
        { c: "Column", p: { gap: 4 }, kids: !stats ? ["Waiting for data"] : none ? ["n/a on this PC"] : [row("DOWN", `${formatBytes(stats.netDown)}/s`), row("UP", `${formatBytes(stats.netUp)}/s`)] },
      ],
    },
  ]);
}

export function feedTree(lines: FeedItem[], activity: string | null, busy: boolean): JarvisNode {
  const items = lines.slice(-6).map((l, i) => ({ id: `l${i}`, message: l.text.slice(0, 120), level: l.tone === "orange" ? "warn" : "info" }));
  if (busy && activity) items.push({ id: "now", message: activity, level: "info" });
  return frame("Activity", [{ c: "JActivityFeed", p: { items: items.length ? items : [{ id: "none", message: "Nothing yet", level: "info" }], maxRows: 6, showTime: false, showSource: false } }], "green");
}

export function radarTree(deviceOnline: boolean, voiceAvailable: boolean): JarvisNode {
  const pill = (name: string, up: boolean): JarvisNode => ({ c: "JStatusPill", p: { state: up ? "active" : "error" }, kids: [`${name} ${up ? "online" : "offline"}`] });
  return frame("Devices", [{ c: "Column", p: { gap: 8 }, kids: [pill("This screen", true), pill("PC agent", deviceOnline), pill("Voice", voiceAvailable)] }]);
}

export function ticketsTree(cells: { status: "done" | "doing" | "review" | "todo" }[], project?: string): JarvisNode {
  const count = (s: string): number => cells.filter((c) => c.status === s).length;
  const total = cells.length;
  const share = (n: number): number => (total ? (100 * n) / total : 0);
  return frame(project ? `Tickets: ${project}` : "Tickets", total ? [row("DONE", String(count("done")), share(count("done")), "success"), row("DOING", String(count("doing")), share(count("doing"))), row("REVIEW", String(count("review")), share(count("review")), "warning"), row("TODO", String(count("todo")), share(count("todo")))] : ["No tickets yet"], "green");
}
