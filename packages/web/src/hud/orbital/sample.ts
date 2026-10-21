import type { PendingApproval } from "@friend/protocol";
import type { HudStats } from "../../store";
import type { Blip, NodeStatus, TicketStatus } from "./kit";

/** The approved mockup's content, shown only when the owner switches on "Show sample data" to preview the look. It is labelled as sample and never mixed with real data. */

export interface SampleNode {
  id: string;
  label: string;
  status: NodeStatus;
  detail: string;
  /** Where the detail text sits on the canvas, and which way it runs from there. */
  at: { x: number; y: number; anchor: "start" | "middle" | "end" };
}

/** In the order of the orbit's slots: top, upper right, lower right, lower left, upper left. */
export const SAMPLE_NODES: SampleNode[] = [
  { id: "code", label: "CODE", status: "running", detail: "▶ Hero.tsx · 62%", at: { x: 800, y: 108, anchor: "middle" } },
  { id: "test", label: "TEST", status: "running", detail: "▶ 12/12 passing", at: { x: 1135, y: 268, anchor: "start" } },
  { id: "rev", label: "REV", status: "waiting", detail: "⏸ needs approval", at: { x: 1135, y: 632, anchor: "start" } },
  { id: "hire", label: "+", status: "add", detail: "HIRE WORKER", at: { x: 465, y: 632, anchor: "end" } },
  { id: "arch", label: "ARCH", status: "idle", detail: "idle", at: { x: 465, y: 268, anchor: "end" } },
];

export const SAMPLE_USAGE = 42;

export const SAMPLE_FEED: { text: string; tone: "green" | "orange" | "plain" }[] = [
  { text: "CODE   ▶ edit src/Hero.tsx", tone: "green" },
  { text: "CODE   + 42 lines  - 6 lines", tone: "plain" },
  { text: "TEST   ▶ pnpm test", tone: "green" },
  { text: "TEST   12 passed · 0 failed", tone: "plain" },
  { text: "REV    ⏸ wants: npm install", tone: "orange" },
  { text: "CODE   ▶ edit src/Nav.tsx", tone: "green" },
  { text: "CODE   + 18 lines", tone: "plain" },
];

const cells = (status: TicketStatus, n: number) => Array.from({ length: n }, () => ({ status }));
export const SAMPLE_TICKETS: { status: TicketStatus }[] = [...cells("done", 3), ...cells("doing", 3), ...cells("review", 1), ...cells("todo", 4)];

export const SAMPLE_BUDGET = [
  { label: "CODE", value: 42 },
  { label: "TEST", value: 70 },
  { label: "REV", value: 25 },
];

export const SAMPLE_BLIPS: Blip[] = [
  { angle: 49, distance: 0.64, label: "PC" },
  { angle: 207, distance: 0.67, label: "PHONE" },
  { angle: 286, distance: 0.73, label: "ALEXA?", warn: true },
];

export const SAMPLE_APPROVAL: PendingApproval = { id: "sample", tool: "shell.run", summary: "npm install --save zod", tier: "T2", needsPin: false };

export const sampleStats = (now: number): HudStats => ({ cpu: 38, ramUsed: 61, ramTotal: 100, netDown: 2.4 * 1024 * 1024, netUp: 0.3 * 1024 * 1024, at: now });