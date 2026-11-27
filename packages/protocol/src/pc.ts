import { z } from "zod";
import type { ToolDef } from "./tools";

/** What the owner lets the assistant do on one PC. A new PC starts with everything off. */
export const PcPermissions = z.object({
  /** May the assistant take a control session (look at the screen, move the mouse, type)? */
  control: z.boolean(),
  /** May it take screenshots and snapshots? Covered by a control session, but kept as its own switch. */
  screen: z.boolean(),
  shell: z.boolean(),
  registry: z.boolean(),
  process: z.boolean(),
  files: z.enum(["off", "read", "write"]),
  /** The folders files and terminal sessions may use. Anything outside is refused, never asked. */
  folders: z.array(z.string().max(300)).max(20),
});
export type PcPermissions = z.infer<typeof PcPermissions>;
export const NO_PC_PERMISSIONS: PcPermissions = { control: false, screen: false, shell: false, registry: false, process: false, files: "off", folders: [] };

export const PC_STATES = ["offline", "idle", "controlling", "paused", "waiting", "error"] as const;
export type PcState = (typeof PC_STATES)[number];

/** The one status record a PC always keeps: what it is doing, the task, the last action. */
export const PcStatus = z.object({
  state: z.enum(PC_STATES),
  task: z.string().max(200).optional(),
  last: z.string().max(300).optional(),
  at: z.number(),
  /** Terminal sessions that are open. */
  sessions: z.number().int().min(0).optional(),
});
export type PcStatus = z.infer<typeof PcStatus>;

const Result = z.object({ output: z.string(), truncated: z.boolean(), image: z.object({ mime: z.string(), data: z.string() }).optional() });

/** What a PC sends to Friend. */
export const PcUp = z.discriminatedUnion("type", [
  z.object({ type: z.literal("hello"), os: z.string().max(80), host: z.string().max(80), version: z.string().max(40), agentSha256: z.string().max(80).optional() }),
  z.object({ type: z.literal("tool.result"), id: z.string(), result: Result }),
  /** `needsApproval`: the PC found something critical on its own screen (a button called Delete, a destructive prompt); the owner is asked and the call is sent again with approved. */
  z.object({ type: z.literal("tool.error"), id: z.string(), error: z.string().max(4000), needsApproval: z.object({ reason: z.string().max(300), detail: z.string().max(1500) }).optional() }),
  z.object({ type: z.literal("status"), status: PcStatus }),
  /** The real person at the PC used the mouse or keyboard. */
  z.object({ type: z.literal("human.input") }),
  z.object({ type: z.literal("lease.ended"), reason: z.string().max(200) }),
]);
export type PcUp = z.infer<typeof PcUp>;

/** What Friend sends to a PC. */
export const PcDown = z.discriminatedUnion("type", [
  z.object({ type: z.literal("tool.exec"), id: z.string(), tool: z.string().max(60), args: z.unknown(), permissions: PcPermissions.optional(), approved: z.boolean().optional() }),
  z.object({ type: z.literal("lease.start"), id: z.string(), minutes: z.number().int().min(1).max(480).optional() }),
  z.object({ type: z.literal("lease.end") }),
  z.object({ type: z.literal("permissions"), permissions: PcPermissions }),
  z.object({ type: z.literal("revoke") }),
  z.object({ type: z.literal("update"), url: z.string().max(300), sha256: z.string().length(64) }),
]);
export type PcDown = z.infer<typeof PcDown>;

const pc = z.string().max(60).optional().describe("The PC's name. Leave it out when only one PC is online; with several, say which.");
const lab = z.number().int().min(0).max(100000).optional().describe("An element number from the last pc.snapshot");
const px = z.number().int().min(-20000).max(20000);
const where = { label: lab, x: px.optional(), y: px.optional() };
const hasTarget = (a: { label?: number | undefined; x?: number | undefined; y?: number | undefined }) => a.label !== undefined || (a.x !== undefined && a.y !== undefined);
const needTarget = { message: "Give an element number (label) from pc.snapshot, or both x and y." };

const KEYS = z.array(z.string().max(30)).min(1).max(30);

function def(name: string, description: string, input: z.ZodTypeAny, baseTier: ToolDef["baseTier"], readOnly = false): ToolDef {
  return { name, description, input, baseTier, target: "gateway", ...(readOnly ? { readOnly: true } : {}) };
}

/** Everything the assistant can do on a Windows PC. A control session is needed to look at the screen and to use the mouse and keyboard. */
export const PC_TOOL_DEFS: ToolDef[] = [
  def("pc.list", "List the owner's Windows PCs with whether each is online, its status (idle, controlling, paused, waiting, error), its current task and when it was last seen.", z.object({}), "T0", true),
  def(
    "pc.control",
    "Start, stop or check the control session on a PC. You need a session to look at its screen and to use its mouse and keyboard; only one runs at a time per PC. While it runs the PC shows a border and a banner, and the owner's own mouse or keyboard use pauses it (you then ask again, and it counts down 3 seconds). Optional minutes (default 30).",
    z.object({ pc, action: z.enum(["start", "stop", "status"]), minutes: z.number().int().min(1).max(480).optional() }),
    "T1",
  ),
  def(
    "pc.tasks",
    "Queue work for a PC (add), see its tasks (list) or cancel one. One task runs at a time under the control session; the others wait. Tasks and their state are kept on the PC and survive a restart (a running task comes back paused).",
    z.object({ pc, action: z.enum(["add", "list", "cancel"]), title: z.string().max(200).optional(), id: z.string().max(40).optional() }),
    "T1",
  ),
  def(
    "pc.snapshot",
    "Look at the PC like a person: a screenshot with every clickable or typeable element numbered, the list of those elements (number, kind, name, place), the open windows and the scrollable areas. Use the numbers with pc.click, pc.type and the others. Call it before acting and again after an action to check the result. Options: vision (include the picture), region [left, top, right, bottom], display (0 based).",
    z.object({ pc, vision: z.boolean().optional(), annotate: z.boolean().optional(), region: z.array(px).length(4).optional(), display: z.number().int().min(0).max(8).optional() }),
    "T1",
  ),
  def("pc.screenshot", "A plain screenshot of the PC (no element list). Options: region, display.", z.object({ pc, annotate: z.boolean().optional(), region: z.array(px).length(4).optional(), display: z.number().int().min(0).max(8).optional() }), "T1"),
  def("pc.displays", "The PC's displays: layout, size, scale.", z.object({ pc }), "T0", true),
  def(
    "pc.click",
    "Click, double click or hover (clicks 0) on an element by its number, or at x and y. button: left (default), right or middle. The mouse moves there smoothly like a hand.",
    z.object({ pc, ...where, button: z.enum(["left", "right", "middle"]).optional(), clicks: z.number().int().min(0).max(3).optional() }).refine(hasTarget, needTarget),
    "T1",
  ),
  def(
    "pc.type",
    "Type text into an element (give its number or x and y) or into what has focus. clear empties the field first; enter presses Enter after; caret: start, idle or end. It checks the text arrived and says if it did not.",
    z.object({ pc, text: z.string().max(4000), ...where, clear: z.boolean().optional(), enter: z.boolean().optional(), caret: z.enum(["start", "idle", "end"]).optional() }),
    "T1",
  ),
  def("pc.scroll", "Scroll at an element or place (or where the mouse is): direction up, down, left or right, times (default 3).", z.object({ pc, ...where, direction: z.enum(["up", "down", "left", "right"]), times: z.number().int().min(1).max(50).optional() }), "T1"),
  def(
    "pc.move",
    "Move the mouse to an element or place; with drag, drag from fromX and fromY (or the current place) to there.",
    z.object({ pc, ...where, drag: z.boolean().optional(), fromX: px.optional(), fromY: px.optional() }).refine(hasTarget, needTarget),
    "T1",
  ),
  def("pc.shortcut", "Press a key combination, for example ctrl+c, alt+tab, win+r, ctrl+shift+esc.", z.object({ pc, keys: z.string().min(1).max(40) }), "T1"),
  def("pc.multi_select", "Select several items at once, by element numbers or points; ctrl holds Ctrl while clicking.", z.object({ pc, labels: z.array(z.number().int()).max(50).optional(), points: z.array(z.array(px).length(2)).max(50).optional(), ctrl: z.boolean().optional() }), "T1"),
  def("pc.multi_edit", "Type into several fields in one go: a list of { label or x and y, text }.", z.object({ pc, edits: z.array(z.object({ ...where, text: z.string().max(2000) })).min(1).max(20) }), "T1"),
  def(
    "pc.app",
    "Launch an app by name (Start menu) or path (with args), switch to a window by name, resize or move it (x, y, w, h) or close it.",
    z.object({ pc, action: z.enum(["launch", "switch", "resize", "move", "close"]), name: z.string().max(200).optional(), path: z.string().max(400).optional(), args: z.array(z.string().max(400)).max(20).optional(), x: px.optional(), y: px.optional(), w: z.number().int().min(50).max(20000).optional(), h: z.number().int().min(50).max(20000).optional() }),
    "T1",
  ),
  def("pc.clipboard", "Read (get) or set the PC's clipboard text.", z.object({ pc, action: z.enum(["get", "set"]), text: z.string().max(20000).optional() }), "T1"),
  def("pc.wait", "Wait a number of seconds (up to 30) before the next step.", z.object({ pc, seconds: z.number().min(0.1).max(30) }), "T1", true),
  def(
    "pc.wait_for",
    "Wait until something is true on the PC, then go on: text_exists (text), window_active (window), element_exists or element_enabled (text is the element's name), focused (text). timeout seconds (default 10, up to 120).",
    z.object({ pc, condition: z.enum(["text_exists", "window_active", "element_exists", "element_enabled", "focused"]), text: z.string().max(300).optional(), window: z.string().max(200).optional(), timeout: z.number().min(1).max(120).optional() }),
    "T1",
    true,
  ),
  def("pc.shell", "Run a PowerShell command on the PC. Needs the shell permission; destructive commands ask the owner.", z.object({ pc, command: z.string().min(1).max(8000), timeoutSeconds: z.number().int().min(1).max(300).optional() }), "T2"),
  def(
    "pc.files",
    "Files on the PC, inside the folders the owner allowed: read, write (content), copy and move (to), delete, list, search (pattern) or info.",
    z.object({ pc, action: z.enum(["read", "write", "copy", "move", "delete", "list", "search", "info"]), path: z.string().min(1).max(500), to: z.string().max(500).optional(), content: z.string().max(200000).optional(), pattern: z.string().max(200).optional() }),
    "T2",
  ),
  def("pc.process", "List processes, or end one by pid or name. Needs the process permission.", z.object({ pc, action: z.enum(["list", "end"]), pid: z.number().int().optional(), name: z.string().max(100).optional() }), "T2"),
  def("pc.registry", "Read, write, delete or list Windows registry keys and values. Needs the registry permission; writes ask the owner.", z.object({ pc, action: z.enum(["read", "write", "delete", "list"]), key: z.string().min(1).max(400), name: z.string().max(200).optional(), value: z.string().max(4000).optional(), type: z.enum(["String", "DWord", "QWord", "ExpandString", "MultiString"]).optional() }), "T2"),
  def("pc.notify", "Show a notification on the PC.", z.object({ pc, title: z.string().max(100), message: z.string().max(400) }), "T1"),
  def(
    "pc.term.open",
    "Open a terminal session on the PC and keep it running between your turns. command: \"claude\" (Claude Code; with resume: true to pick up the most recent session, or resume: <session id>, or continue: true), \"shell\" (PowerShell), or another program. cwd is the project folder (an allowed folder). Returns the session id. You then read the screen with pc.term.read and answer with pc.term.send, like a person at that terminal. Needs the shell permission.",
    z.object({ pc, cwd: z.string().max(500).optional(), command: z.string().max(200).optional(), args: z.array(z.string().max(400)).max(20).optional(), resume: z.union([z.boolean(), z.string().max(80)]).optional(), continue: z.boolean().optional() }),
    "T2",
  ),
  def("pc.term.list", "List the open terminal sessions on the PC (id, program, folder, state).", z.object({ pc }), "T0", true),
  def("pc.term.read", "Read a terminal session's screen as text, with whether it looks busy, idle or waiting at a prompt or menu, and the options it shows. lines limits how much.", z.object({ pc, id: z.string().max(40), lines: z.number().int().min(1).max(200).optional() }), "T1", true),
  def(
    "pc.term.send",
    "Type into a terminal session: text (add enter: true to press Enter), and/or named keys such as Enter, Esc, Tab, Up, Down, Left, Right, Backspace, Ctrl+C. To choose a menu option, press Down until it is highlighted, then Enter. A destructive prompt (delete, force push, drop, format, run as admin) is not answered by you: the owner is asked.",
    z.object({ pc, id: z.string().max(40), text: z.string().max(8000).optional(), keys: KEYS.optional(), enter: z.boolean().optional() }).refine((a) => a.text !== undefined || a.keys !== undefined, { message: "Give text, keys, or both." }),
    "T1",
  ),
  def("pc.term.wait", "Wait for a terminal session to go quiet (until idle, the default) or to show some text, up to a timeout (seconds, default 60), then return its screen.", z.object({ pc, id: z.string().max(40), until: z.enum(["idle", "text"]).optional(), text: z.string().max(300).optional(), timeout: z.number().min(1).max(300).optional() }), "T1", true),
  def("pc.term.close", "End a terminal session.", z.object({ pc, id: z.string().max(40) }), "T1"),
  def("pc.claude.sessions", "List the earlier Claude Code sessions of a project on the PC (id, last message, when), newest first, to choose which to resume.", z.object({ pc, project: z.string().min(1).max(500) }), "T1", true),
];

export const PC_TOOL_NAMES: string[] = PC_TOOL_DEFS.map((d) => d.name);
export const isPcTool = (name: string): boolean => name.startsWith("pc.");

/** What a PC call says on an approval card. */
export function describePcCall(name: string, a: Record<string, unknown>): string {
  const base = describeBase(name, a);
  return typeof a.reason === "string" && a.reason ? `${base}. ${a.reason}${typeof a.detail === "string" && a.detail ? `: ${a.detail.slice(0, 600)}` : ""}` : base;
}

function describeBase(name: string, a: Record<string, unknown>): string {
  const on = typeof a.pc === "string" && a.pc ? ` on ${a.pc}` : "";
  const q = (v: unknown, n = 200) => String(v ?? "").slice(0, n);
  switch (name) {
    case "pc.shell":
      return `Run on the PC${on}: ${q(a.command, 600)}`;
    case "pc.files":
      return `${q(a.action)} ${q(a.path)}${a.to ? ` to ${q(a.to)}` : ""}${on}`;
    case "pc.registry":
      return `Registry ${q(a.action)} ${q(a.key)}${a.name ? ` ${q(a.name)}` : ""}${on}`;
    case "pc.process":
      return `Processes: ${q(a.action)}${a.name ? ` ${q(a.name)}` : ""}${a.pid ? ` ${q(a.pid)}` : ""}${on}`;
    case "pc.term.open":
      return `Open a terminal${on}: ${q(a.command || "shell")}${a.resume ? " (resume)" : ""} in ${q(a.cwd || "the default folder")}`;
    case "pc.term.send":
      return `Type into the terminal${on}${a.text ? ` (${String(a.text).length} characters)` : ""}${Array.isArray(a.keys) ? ` keys ${a.keys.join(" ")}` : ""}`;
    case "pc.control":
      return `${q(a.action)} the control session${on}`;
    case "pc.click":
      return `Click${on}${a.label !== undefined ? ` element ${q(a.label)}` : ` at ${q(a.x)},${q(a.y)}`}`;
    case "pc.type":
      return `Type ${String(a.text ?? "").length} characters${on}`;
    case "pc.app":
      return `App ${q(a.action)} ${q(a.name || a.path)}${on}`;
    default:
      return `${name.replace(/^pc\./, "PC ")}${on}`;
  }
}
