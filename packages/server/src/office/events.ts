import type { OfficeQuota } from "@friend/protocol";

/** What a worker's stream-json output means to Friend, normalised. Unknown or partial events give nothing. */
export type WorkerEvent =
  | { kind: "init"; sessionId: string; model: string }
  | { kind: "text"; text: string }
  | { kind: "tool"; id: string; name: string; summary: string }
  | { kind: "tool_result"; id: string; ok: boolean; text: string }
  | { kind: "quota"; quota: OfficeQuota }
  | { kind: "result"; ok: boolean; text: string; turns: number; durationMs: number; input: number; output: number; denials: string[]; sessionId: string };

const MAX_TEXT = 4000;
const SUMMARY_CHARS = 80;
const FILE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "Read", "NotebookEdit"]);

const obj = (v: unknown): Record<string, any> => (v && typeof v === "object" ? (v as Record<string, any>) : {});
const clip = (s: string, n = MAX_TEXT): string => (s.length > n ? s.slice(0, n) : s);
const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);

/** One line saying what a tool call does, for the feed and the ticket. Never file contents, never a long command. */
export function summarizeToolCall(name: string, input: unknown): string {
  const i = obj(input);
  let s = name;
  if (FILE_TOOLS.has(name) && typeof i.file_path === "string") s = `${name} ${i.file_path.split(/[\\/]/).filter(Boolean).at(-1) ?? ""}`.trim();
  else if (name === "Bash" && typeof i.command === "string") s = `Bash: ${i.command.replace(/\s+/g, " ").trim()}`;
  return clip(s, SUMMARY_CHARS);
}

function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) return content.map((b) => (typeof b === "string" ? b : typeof obj(b).text === "string" ? obj(b).text : "")).join("");
  return "";
}

function windowOf(w: unknown): { utilization: number; resetsAt: number } | null {
  const o = obj(w);
  return typeof o.utilization === "number" && typeof o.resetsAt === "number" ? { utilization: Math.min(1, Math.max(0, o.utilization)), resetsAt: o.resetsAt } : null;
}

export function parseWorkerEvent(ev: unknown): WorkerEvent[] {
  const e = obj(ev);
  switch (e.type) {
    case "system":
      return e.subtype === "init" && typeof e.session_id === "string" ? [{ kind: "init", sessionId: e.session_id, model: typeof e.model === "string" ? e.model : "" }] : [];
    case "assistant":
      return (Array.isArray(e.message?.content) ? e.message.content : []).flatMap((b: unknown): WorkerEvent[] => {
        const block = obj(b);
        if (block.type === "text" && typeof block.text === "string" && block.text.trim()) return [{ kind: "text", text: clip(block.text) }];
        if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") return [{ kind: "tool", id: block.id, name: block.name, summary: summarizeToolCall(block.name, block.input) }];
        return [];
      });
    case "user":
      return (Array.isArray(e.message?.content) ? e.message.content : []).flatMap((b: unknown): WorkerEvent[] => {
        const block = obj(b);
        return block.type === "tool_result" && typeof block.tool_use_id === "string" ? [{ kind: "tool_result", id: block.tool_use_id, ok: block.is_error !== true, text: clip(textOf(block.content)) }] : [];
      });
    case "rate_limit_event": {
      const info = obj(e.rate_limit_info);
      const windows = obj(info.unifiedWindows);
      const fiveHour = windowOf(windows.five_hour) ?? (info.rateLimitType === "five_hour" ? windowOf(info) : null);
      const sevenDay = windowOf(windows.seven_day) ?? (info.rateLimitType === "seven_day" ? windowOf(info) : null);
      return fiveHour || sevenDay ? [{ kind: "quota", quota: { fiveHour, sevenDay } }] : [];
    }
    case "result": {
      const u = obj(e.usage);
      return [
        {
          kind: "result",
          ok: e.is_error !== true && e.subtype === "success",
          text: clip(typeof e.result === "string" ? e.result : ""),
          turns: num(e.num_turns),
          durationMs: num(e.duration_ms),
          input: num(u.input_tokens) + num(u.cache_creation_input_tokens),
          output: num(u.output_tokens),
          denials: (Array.isArray(e.permission_denials) ? e.permission_denials : []).map((d: unknown) => String(obj(d).tool_name ?? "")).filter(Boolean),
          sessionId: typeof e.session_id === "string" ? e.session_id : "",
        },
      ];
    }
    default:
      return [];
  }
}