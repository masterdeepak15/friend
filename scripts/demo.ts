/**
 * Friend demo: runs the real gateway and web client with a scripted fake model, so you can see the
 * stage (objects, auto layout, presence styles, moods) without an API key or any network access.
 * Every message you send advances to the next scene.
 *
 *   pnpm build && pnpm demo
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createApp } from "../packages/server/src/app";
import type { Provider, ProviderEvent, StreamRequest } from "../packages/server/src/provider/types";

const PASSWORD = "demo-friend-2026";
const PIN = "246810";
const PORT = Number(process.env.FRIEND_DEMO_PORT ?? 8788);

type Call = { name: string; args: unknown };
const show = (id: string, type: string, props: Record<string, unknown>, placement: unknown = "auto", extra: object = {}): Call => ({
  name: "stage.show",
  args: { object: { id, type, props, placement, ...extra } },
});
const clear: Call = { name: "stage.clear", args: {} };

const hours = Array.from({ length: 12 }, (_, i) => `${i * 2}:00`);
const wave = (base: number, amp: number, shift: number) => hours.map((_, i) => Math.round(base + amp * Math.sin(i / 1.7 + shift)));

const SCENES: { say: string; calls: Call[] }[] = [
  {
    say: "Good evening, boss. Systems are online. Here is your overview.",
    calls: [
      clear,
      { name: "stage.scene", args: { mode: "multi" } },
      show("cpu", "gauge", { label: "CPU", value: 42, unit: "%" }),
      show("ram", "gauge", { label: "Memory", value: 83, unit: "%" }),
      show("disk", "gauge", { label: "Disk C:", value: 97, unit: "%" }),
      show("load", "chart", { title: "Load, last 24 h", kind: "area", labels: hours, series: [{ name: "cpu", values: wave(40, 25, 0) }, { name: "network", values: wave(30, 15, 2) }] }),
      show("up", "stat", { label: "Uptime", value: "14.2", unit: "days", delta: "no restarts" }),
    ],
  },
  {
    say: "Here is what is on your plate today.",
    calls: [
      clear,
      { name: "stage.scene", args: { mode: "multi" } },
      show("sched", "timeline", { title: "Today", items: [{ time: "09:00", title: "Stand-up", detail: "Team room" }, { time: "11:30", title: "Review pull requests", detail: "3 waiting" }, { time: "14:00", title: "Deploy window" }, { time: "17:30", title: "Gym" }] }),
      show("todo", "list", { title: "Tasks", items: ["Renew the domain", { text: "Back up the workspace", done: true }, "Reply to the landlord"] }),
      show("tbl", "table", { title: "Largest folders", columns: ["Folder", "Size"], rows: [["node_modules", "412 MB"], ["Downloads", "3.1 GB"], ["Videos", "18.4 GB"]] }),
    ],
  },
  {
    say: "This is how your services talk to each other.",
    calls: [
      clear,
      { name: "stage.scene", args: { mode: "focus" } },
      { name: "stage.presence", args: { style: "ring" } },
      show("svc", "graph", { title: "Services", nodes: [{ id: "web", label: "Web UI" }, { id: "gw", label: "Gateway" }, { id: "agent", label: "Agent" }, { id: "dev", label: "Device node" }, { id: "db", label: "SQLite" }, { id: "llm", label: "Claude" }], edges: [{ from: "web", to: "gw", label: "ws" }, { from: "gw", to: "agent" }, { from: "agent", to: "llm" }, { from: "agent", to: "dev", label: "tools" }, { from: "gw", to: "db" }] }, "center"),
    ],
  },
  {
    say: "Switching to the orb, with a warmer mood.",
    calls: [
      clear,
      { name: "stage.presence", args: { style: "orb" } },
      { name: "stage.mood", args: { accent: "#ffb454", intensity: 0.9 } },
      show("note", "card", { title: "Heads up", text: "Disk C: is **97% full**. Want me to find what is taking the space?" }, "bottom", { style: "alert", ttl: 20 }),
    ],
  },
  {
    say: "Back to the sphere. Anything else?",
    calls: [clear, { name: "stage.presence", args: { style: "sphere" } }, { name: "stage.mood", args: { accent: "#3fd8ff", intensity: 0.6 } }],
  },
];

class DemoProvider implements Provider {
  id = "demo";
  async *stream(req: StreamRequest): AsyncIterable<ProviderEvent> {
    const last = req.messages.at(-1);
    if (last?.role === "tool") {
      yield { type: "text_delta", text: " Anything else?" };
      yield { type: "done" };
      return;
    }
    const turns = req.messages.filter((m) => m.role === "user" && m.content.some((b) => b.type === "text")).length;
    const scene = SCENES[(Math.max(turns, 1) - 1) % SCENES.length]!;
    for (const word of scene.say.split(" ")) {
      yield { type: "text_delta", text: word + " " };
      await new Promise((r) => setTimeout(r, 45));
    }
    for (const [i, c] of scene.calls.entries()) yield { type: "tool_call", id: `demo-${turns}-${i}`, name: c.name, args: c.args };
    yield { type: "done" };
  }
}

const app = await createApp({
  dataDir: mkdtempSync(join(tmpdir(), "friend-demo-")),
  webDir: resolve(import.meta.dirname, "../packages/web/dist"),
  provider: new DemoProvider(),
  config: { port: PORT, roots: [] },
});
await app.auth.setupOwner({ password: PASSWORD, pin: PIN, assistantName: "Jarvis" });
const { port } = await app.start();

console.log(`\nFriend demo is running (scripted model, no network).\n`);
console.log(`  Open:      http://127.0.0.1:${port}`);
console.log(`  Password:  ${PASSWORD}`);
console.log(`  Then press any key and send a message; each message shows the next scene.\n`);
console.log(`Press Ctrl+C to stop.`);

process.once("SIGINT", async () => {
  await app.stop();
  process.exit(0);
});
