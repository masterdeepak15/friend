import { loadConfig } from "@friend/server";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { IO } from "../cli";

const USAGE = [
  "Usage: friend audit list [--since 2h|1d|7d] [--who owner|assistant|worker|system|outsider|<worker name>] [--group approvals|tools|workers|logins|messages|settings|system] [--result refused|failed|done] [--q text] [--limit N]",
  "       friend audit show <request-id>",
  "       friend audit verify [--seal \"Friend audit seal ...\"]",
  "       friend audit export --format json|csv|html [--since 7d]   (saves a file in this folder)",
  "       friend audit seal",
].join("\n");

/** What the command needs from outside; tests replace it. */
export interface AuditCliDeps {
  fetch?: typeof fetch;
  port?: number;
  now?: () => number;
  /** Saves a file in the current folder. */
  write?: (name: string, body: string) => void;
}

interface Row {
  id: number;
  ts: number;
  actorKind: string;
  actorId: string;
  kind: string;
  target: string;
  outcome: string;
  detail: Record<string, unknown>;
}
interface Node {
  row: Row;
  children: Node[];
}

/** Logged text may hold anything a worker, a web page or a stranger wrote: nothing that moves the cursor or sets the title reaches the terminal. */
const plain = (s: unknown): string =>
  String(s)
    .replace(/\u001b\][^\u0007\u001b]*(\u0007|\u001b\\)?/g, "")
    .replace(/\u001b\[[0-9;?]*[ -/]*[@-~]/g, "")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, " ");

const ACTORS = new Set(["owner", "assistant", "worker", "system", "outsider"]);
const when = (ts: number) => new Date(ts).toISOString().replace("T", " ").slice(0, 19);
const line = (r: Row, depth = 0) => `${"  ".repeat(depth)}#${r.id} ${when(r.ts)} ${r.actorKind}${r.actorId && r.actorId !== r.actorKind ? ` ${plain(r.actorId)}` : ""} ${plain(r.kind)}${r.target ? ` ${plain(r.target)}` : ""}${r.outcome ? ` [${r.outcome}]` : ""} ${plain(JSON.stringify(r.detail)).slice(0, 200)}`.trimEnd();
const tree = (nodes: Node[], depth: number, out: string[]) => {
  for (const n of nodes) {
    out.push(line(n.row, depth));
    tree(n.children, depth + 1, out);
  }
};

/** Parses the shared filter flags into the query the server takes. Returns an error text when a flag is bad. */
function filters(args: string[], now: number): { query: Record<string, string>; error?: string } {
  const q: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i]!;
    const value = args[i + 1];
    if (value === undefined) return { query: q, error: `${flag} needs a value.` };
    i++;
    if (flag === "--since") {
      const m = /^(\d+)([mhd])$/.exec(value);
      if (!m) return { query: q, error: "--since is like 30m, 2h or 7d." };
      q.from = String(now - Number(m[1]) * { m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2] as "m" | "h" | "d"]);
    } else if (flag === "--who") q[ACTORS.has(value) ? "actorKind" : "actorId"] = value;
    else if (flag === "--group") q.group = value;
    else if (flag === "--result") q.outcome = value;
    else if (flag === "--q") q.q = value;
    else if (flag === "--limit") q.limit = value;
    else if (flag === "--format") q.format = value;
    else return { query: q, error: `Unknown flag ${flag}.` };
  }
  return { query: q };
}

/**
 * `friend audit`: reads the audit trail from the running Friend. It asks for the owner's PIN and gives it to Friend itself (from this PC
 * only); it never opens the database, so the PIN rule cannot be walked around.
 */
export async function auditCommand(args: string[], io: IO, deps: AuditCliDeps = {}): Promise<number> {
  const [sub, ...rest] = args;
  const now = (deps.now ?? Date.now)();
  const bad = (text: string) => {
    io.err(text);
    io.err(USAGE);
    return 1;
  };
  if (!sub || !["list", "show", "verify", "export", "seal"].includes(sub)) return bad(sub ? `Unknown audit command: ${plain(sub)}` : "Say what to do.");

  let path = "";
  let init: RequestInit = {};
  let afterwards: ((res: Response) => Promise<number>) | null = null;
  const sealIndex = rest.indexOf("--seal");

  if (sub === "list") {
    const f = filters(rest, now);
    if (f.error) return bad(f.error);
    path = `/api/audit?${new URLSearchParams(f.query)}`;
    afterwards = async (res) => {
      const body = (await res.json()) as { rows: Row[]; counts: { total: number; refused: number; failed: number } };
      for (const r of body.rows) io.out(line(r));
      io.out(`${body.counts.total} entries, ${body.counts.refused} refused, ${body.counts.failed} failed`);
      return 0;
    };
  } else if (sub === "show") {
    const id = rest[0];
    if (!id) return bad("Give a request id.");
    path = `/api/audit/request/${encodeURIComponent(id)}`;
    afterwards = async (res) => {
      const out: string[] = [];
      tree(((await res.json()) as { tree: Node[] }).tree, 0, out);
      for (const l of out.length ? out : ["Nothing was recorded for that request."]) io.out(l);
      return 0;
    };
  } else if (sub === "verify" && sealIndex >= 0) {
    const text = rest[sealIndex + 1];
    if (!text) return bad("--seal needs the seal text.");
    path = "/api/audit/verify-seal";
    init = { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text }) };
    afterwards = async (res) => {
      const r = (await res.json()) as { ok: boolean; reason?: string };
      if (r.ok) io.out("Seal OK: the log still holds that entry.");
      else io.err(`Seal does not match: ${plain(r.reason ?? "unknown")}`);
      return r.ok ? 0 : 1;
    };
  } else if (sub === "verify") {
    path = "/api/audit/verify";
    afterwards = async (res) => {
      const r = (await res.json()) as { ok: boolean; rows?: number; brokenAt?: number; reason?: string };
      if (r.ok) io.out(`OK (${r.rows} rows)`);
      else io.err(`BROKEN at ${r.brokenAt} (${plain(r.reason ?? "")}). Something changed the log.`);
      return r.ok ? 0 : 1;
    };
  } else if (sub === "seal") {
    path = "/api/audit/seal";
    afterwards = async (res) => {
      io.out(((await res.json()) as { text: string }).text);
      return 0;
    };
  } else {
    const f = filters(rest, now);
    if (f.error) return bad(f.error);
    if (!["json", "csv", "html"].includes(f.query.format ?? "")) return bad("--format must be json, csv or html.");
    path = `/api/audit/export?${new URLSearchParams(f.query)}`;
    afterwards = async (res) => {
      const raw = /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? `friend-audit.${f.query.format}`;
      const name = (raw.split(/[\\/]/).pop() ?? "friend-audit").replace(/[^A-Za-z0-9._-]/g, "_") || "friend-audit";
      (deps.write ?? ((n, b) => writeFileSync(join(process.cwd(), n), b)))(name, await res.text());
      io.out(`Saved ${name} in this folder. It contains private content: keep it safe.`);
      return 0;
    };
  }

  const pin = await io.ask("PIN: ", { hidden: true });
  const port = deps.port ?? loadConfig(io.dataDir).port;
  let res: Response;
  try {
    res = await (deps.fetch ?? fetch)(`http://127.0.0.1:${port}${path}`, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), "x-owner-pin": pin } });
  } catch {
    io.err("Friend is not running on this PC (or runs on another port). Start it with: friend start");
    return 1;
  }
  if (!res.ok) {
    let message = `The request failed (${res.status}).`;
    try {
      message = plain(((await res.json()) as { error?: string }).error ?? message);
    } catch {
      /* no JSON body */
    }
    io.err(message);
    return 1;
  }
  return afterwards!(res);
}
