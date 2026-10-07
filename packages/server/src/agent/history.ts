import type { Db } from "../db";
import type { ContentBlock, Msg } from "../provider/types";

const WINDOW = 40;

export function saveMessage(db: Db, msg: Msg): void {
  db.prepare("insert into messages (role, content_json, created_at) values (?, ?, ?)").run(
    msg.role,
    JSON.stringify(msg.content),
    Date.now(),
  );
}

function loadAll(db: Db, limit: number): Msg[] {
  const rows = db.prepare("select role, content_json from messages order by id desc limit ?").all(limit) as {
    role: Msg["role"];
    content_json: string;
  }[];
  return rows.reverse().map((r) => ({ role: r.role, content: JSON.parse(r.content_json) as ContentBlock[] }));
}

/** If the last stored assistant message has tool calls with no results (a crash mid-turn), add error results. */
export function repairDangling(db: Db): void {
  const last = loadAll(db, 1)[0];
  if (!last || last.role !== "assistant") return;
  const calls = last.content.filter((b) => b.type === "tool_use");
  if (calls.length === 0) return;
  saveMessage(db, {
    role: "tool",
    content: calls.map((c) => ({
      type: "tool_result" as const,
      toolUseId: (c as { id: string }).id,
      content: "Interrupted: the previous turn ended before this tool finished.",
      isError: true,
    })),
  });
}

/** Recent history starting at a user text message, so tool_use/tool_result pairs are never split. */
export function loadHistory(db: Db): Msg[] {
  const msgs = loadAll(db, WINDOW);
  const start = msgs.findIndex((m) => m.role === "user" && m.content.some((b) => b.type === "text"));
  return start === -1 ? [] : msgs.slice(start);
}
