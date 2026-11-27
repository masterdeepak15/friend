import { checkPcCall, insideFolders, type PcPermissions } from "@friend/protocol";
import { execFile } from "node:child_process";
import { promises as fs, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Control } from "./control";
import { elementVerdict, offLimits, type Touched } from "./guard";
import type { Helper } from "./helper";
import type { StatusKeeper } from "./status";
import type { AgentStore } from "./store";
import type { Tasks } from "./tasks";

export type ToolOutcome = { ok: true; output: string; truncated: boolean; image?: { mime: string; data: string } } | { ok: false; error: string; needsApproval?: { reason: string; detail: string } };

type Exec = (file: string, args: string[], opts: { timeout: number; env?: NodeJS.ProcessEnv; maxBuffer: number }) => Promise<{ stdout: string; stderr: string; code: number }>;

/** The tools that terminals add (Task: terminal sessions). */
export interface TerminalTools {
  run(name: string, args: Record<string, unknown>, perms: PcPermissions): Promise<ToolOutcome>;
}

export interface PcToolDeps {
  helper: Pick<Helper, "call">;
  control: Control;
  tasks: Tasks;
  store: AgentStore;
  status: StatusKeeper;
  perms: () => PcPermissions;
  terms?: TerminalTools;
  exec?: Exec;
  sleep?: (ms: number) => Promise<void>;
}

const MAX_OUT = 60_000;
const cut = (s: string): { output: string; truncated: boolean } => (s.length > MAX_OUT ? { output: `${s.slice(0, MAX_OUT)}\n[cut]`, truncated: true } : { output: s, truncated: false });
const done = (s: string): ToolOutcome => ({ ok: true, ...cut(s) });
const fail = (error: string): ToolOutcome => ({ ok: false, error });

const defaultExec: Exec = (file, args, opts) =>
  new Promise((resolve) => {
    execFile(file, args, { ...opts, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === "number" ? ((err as { code: number }).code) : 1) : 0;
      resolve({ stdout: String(stdout), stderr: err && (err as { killed?: boolean }).killed ? `${stderr}\n[stopped: it took too long]` : String(stderr), code });
    });
  });

const INPUT_WITH_TARGET = new Set(["pc.click", "pc.type", "pc.move", "pc.scroll"]);
const NEEDS_LEASE = new Set(["pc.snapshot", "pc.screenshot", "pc.click", "pc.type", "pc.scroll", "pc.move", "pc.shortcut", "pc.multi_select", "pc.multi_edit", "pc.app", "pc.clipboard", "pc.notify", "pc.wait_for"]);

/** Who is allowed to touch what on this PC, checked again here with what only the PC can see. The server has already asked the owner about anything critical it could tell from the call itself. */
export async function runTool(d: PcToolDeps, name: string, rawArgs: unknown, approved: boolean): Promise<ToolOutcome> {
  const args = (rawArgs ?? {}) as Record<string, unknown>;
  const perms = d.perms();
  const verdict = checkPcCall(name, args, perms, { lease: d.control.canAct() }, perms.askPatterns ?? []);
  if (verdict.decision === "deny") return fail(verdict.reason ?? "Not allowed on this PC.");
  if (NEEDS_LEASE.has(name) && !d.control.canAct()) return fail("There is no control session on this PC.");
  d.control.touch();
  const started = Date.now();
  let out: ToolOutcome;
  try {
    out = await dispatch(d, name, args, perms, approved);
  } catch (e) {
    out = fail((e as Error).message);
  }
  d.store.addEvent({ tool: name, ok: out.ok, detail: out.ok ? `${Date.now() - started} ms` : out.error.slice(0, 200) });
  if (out.ok || !out.needsApproval) d.status.set({ last: `${name.replace(/^pc\./, "")}${out.ok ? "" : " failed"}` });
  return out;
}

async function look(d: PcToolDeps, op: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const r = await d.helper.call(op, args, 90_000);
  return { ok: true, ...cut(r.text), ...(r.image ? { image: { mime: r.image.mime, data: r.image.data } } : {}) };
}

/** Finds out which control a click or typing is about, so it can be checked. */
async function touched(d: PcToolDeps, args: Record<string, unknown>): Promise<Touched | null> {
  let r: { text: string };
  if (typeof args.label === "number") r = await d.helper.call("element", { label: args.label });
  else if (typeof args.x === "number" && typeof args.y === "number") r = await d.helper.call("at", { x: args.x, y: args.y });
  else return null;
  const [type = "", name = "", window = ""] = r.text.split("|");
  return { type, name, window };
}

async function dispatch(d: PcToolDeps, name: string, a: Record<string, unknown>, perms: PcPermissions, approved: boolean): Promise<ToolOutcome> {
  const helper = d.helper;
  if (INPUT_WITH_TARGET.has(name) || name === "pc.shortcut" || name === "pc.multi_select" || name === "pc.multi_edit" || name === "pc.clipboard" || name === "pc.app") {
    const fg = (await helper.call("window", {})).text;
    const blocked = offLimits(fg, perms);
    if (blocked && name !== "pc.app" && !(name === "pc.clipboard" && a.action === "get")) return fail(blocked);
    if (INPUT_WITH_TARGET.has(name)) {
      const t = await touched(d, a);
      if (t) {
        const v = elementVerdict(t, perms, approved);
        if (v.decision === "deny") return fail(v.reason);
        if (v.decision === "ask") return { ok: false, error: `This looks critical: ${v.reason}. The owner has to approve it.`, needsApproval: { reason: v.reason, detail: v.detail } };
      }
    }
  }
  switch (name) {
    case "pc.snapshot":
      return look(d, "snapshot", a);
    case "pc.screenshot":
      return look(d, "screenshot", a);
    case "pc.displays":
      return look(d, "displays", {});
    case "pc.click":
    case "pc.type":
    case "pc.scroll":
    case "pc.move":
    case "pc.shortcut":
    case "pc.multi_select":
    case "pc.multi_edit":
    case "pc.app":
    case "pc.clipboard":
    case "pc.wait_for":
    case "pc.notify":
      return look(d, name.replace(/^pc\./, ""), a);
    case "pc.wait": {
      const s = typeof a.seconds === "number" ? a.seconds : 1;
      await (d.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms))))(s * 1000);
      return done(`Waited ${s} seconds.`);
    }
    case "pc.shell":
      return shell(d, a);
    case "pc.files":
      return files(a, perms);
    case "pc.process":
      return processes(d, a);
    case "pc.registry":
      return registry(d, a);
    case "pc.tasks":
      return tasks(d, a);
    default:
      if (name.startsWith("pc.term.") || name === "pc.claude.sessions") return d.terms ? d.terms.run(name, a, perms) : fail("Terminal sessions are not available on this PC.");
      return fail(`This PC does not know the tool ${name}.`);
  }
}

async function shell(d: PcToolDeps, a: Record<string, unknown>): Promise<ToolOutcome> {
  const command = String(a.command ?? "");
  const seconds = typeof a.timeoutSeconds === "number" ? a.timeoutSeconds : 60;
  const r = await (d.exec ?? defaultExec)("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", `$OutputEncoding = [Console]::OutputEncoding = [Text.UTF8Encoding]::new($false); ${command}`], { timeout: seconds * 1000, maxBuffer: 8 * 1024 * 1024 });
  const text = `${r.stdout}${r.stderr ? `${r.stdout ? "\n" : ""}[errors]\n${r.stderr}` : ""}`.trim();
  return r.code === 0 ? done(text || "(no output)") : { ok: false, error: `Exit code ${r.code}.${text ? `\n${text.slice(0, 3000)}` : ""}` };
}

/** A path that really is inside an allowed folder once links and junctions are followed. */
function realInside(path: string, folders: string[]): boolean {
  let probe = path;
  for (let i = 0; i < 40; i++) {
    try {
      const real = realpathSync(probe);
      const rest = path.slice(probe.length);
      return insideFolders(real + rest, folders.map((f) => { try { return realpathSync(f); } catch { return f; } }));
    } catch {
      const up = dirname(probe);
      if (up === probe) return false;
      probe = up;
    }
  }
  return false;
}

async function files(a: Record<string, unknown>, perms: PcPermissions): Promise<ToolOutcome> {
  const action = String(a.action);
  const path = String(a.path);
  const to = typeof a.to === "string" ? a.to : "";
  for (const p of [path, to]) if (p && !realInside(p, perms.folders)) return fail("That path leads outside the folders the owner allowed (through a link or a shortcut).");
  switch (action) {
    case "read": {
      const st = await fs.stat(path);
      if (st.size > 5_000_000) return fail(`That file is ${Math.round(st.size / 1e6)} MB: too big to read whole.`);
      return done((await fs.readFile(path, "utf8")).slice(0, 200_000));
    }
    case "write":
      await fs.mkdir(dirname(path), { recursive: true });
      await fs.writeFile(path, String(a.content ?? ""), "utf8");
      return done(`Wrote ${String(a.content ?? "").length} characters to ${path}.`);
    case "copy":
      await fs.cp(path, to, { recursive: true, force: false, errorOnExist: true });
      return done(`Copied to ${to}.`);
    case "move":
      await fs.rename(path, to);
      return done(`Moved to ${to}.`);
    case "delete":
      await fs.rm(path, { recursive: true, force: false });
      return done(`Deleted ${path}.`);
    case "list": {
      const entries = await fs.readdir(path, { withFileTypes: true });
      return done(entries.slice(0, 500).map((e) => `${e.isDirectory() ? "[dir] " : "      "}${e.name}`).join("\n") || "(empty)");
    }
    case "info": {
      const st = await fs.stat(path);
      return done(`${st.isDirectory() ? "folder" : "file"}, ${st.size} bytes, changed ${st.mtime.toISOString()}`);
    }
    case "search": {
      const needle = String(a.pattern ?? "").toLowerCase();
      if (!needle) return fail("Give a pattern to look for in the names.");
      const found: string[] = [];
      let seen = 0;
      const walk = async (dir: string): Promise<void> => {
        if (found.length >= 200 || seen > 20_000) return;
        for (const e of await fs.readdir(dir, { withFileTypes: true }).catch(() => [])) {
          if (++seen > 20_000) return;
          const full = join(dir, e.name);
          if (e.name.toLowerCase().includes(needle)) found.push(full);
          if (e.isDirectory() && !e.isSymbolicLink()) await walk(full);
        }
      };
      await walk(path);
      return done(found.join("\n") || "Nothing found.");
    }
    default:
      return fail(`Unknown files action: ${action}`);
  }
}

async function processes(d: PcToolDeps, a: Record<string, unknown>): Promise<ToolOutcome> {
  const ex = d.exec ?? defaultExec;
  if (a.action === "list") {
    const r = await ex("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "Get-Process | Sort-Object WS -Descending | Select-Object -First 60 Id, ProcessName, @{n='MB';e={[int]($_.WS/1MB)}} | Format-Table -AutoSize | Out-String -Width 200"], { timeout: 20_000, maxBuffer: 1_000_000 });
    return done(r.stdout.trim());
  }
  const env = { ...process.env, FR_PID: typeof a.pid === "number" ? String(a.pid) : "", FR_NAME: typeof a.name === "string" ? a.name : "" };
  if (!env.FR_PID && !env.FR_NAME) return fail("Give a pid or a name.");
  const r = await ex("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", "if ($env:FR_PID) { Stop-Process -Id ([int]$env:FR_PID) -ErrorAction Stop } else { Stop-Process -Name $env:FR_NAME -ErrorAction Stop }; 'Ended.'"], { timeout: 20_000, maxBuffer: 100_000, env });
  return r.code === 0 ? done("Ended.") : fail(r.stderr.trim() || "Could not end it.");
}

async function registry(d: PcToolDeps, a: Record<string, unknown>): Promise<ToolOutcome> {
  const env = { ...process.env, FR_KEY: String(a.key ?? ""), FR_NAME: typeof a.name === "string" ? a.name : "", FR_VALUE: typeof a.value === "string" ? a.value : "", FR_TYPE: typeof a.type === "string" ? a.type : "String" };
  const scripts: Record<string, string> = {
    read: "if ($env:FR_NAME) { (Get-ItemProperty -Path $env:FR_KEY -Name $env:FR_NAME -ErrorAction Stop).($env:FR_NAME) } else { Get-ItemProperty -Path $env:FR_KEY -ErrorAction Stop | Format-List | Out-String -Width 200 }",
    list: "Get-ChildItem -Path $env:FR_KEY -ErrorAction Stop | Select-Object -First 100 -ExpandProperty Name",
    write: "$v = $env:FR_VALUE; if ($env:FR_TYPE -eq 'DWord') { $v = [int]$v } elseif ($env:FR_TYPE -eq 'QWord') { $v = [long]$v }; if (-not (Test-Path $env:FR_KEY)) { New-Item -Path $env:FR_KEY -Force | Out-Null }; Set-ItemProperty -Path $env:FR_KEY -Name $env:FR_NAME -Value $v -Type $env:FR_TYPE -ErrorAction Stop; 'Written.'",
    delete: "if ($env:FR_NAME) { Remove-ItemProperty -Path $env:FR_KEY -Name $env:FR_NAME -ErrorAction Stop } else { Remove-Item -Path $env:FR_KEY -Recurse -ErrorAction Stop }; 'Deleted.'",
  };
  const script = scripts[String(a.action)];
  if (!script) return fail("Unknown registry action.");
  const r = await (d.exec ?? defaultExec)("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { timeout: 20_000, maxBuffer: 1_000_000, env });
  return r.code === 0 ? done(r.stdout.trim() || "Done.") : fail(r.stderr.trim().slice(0, 800) || "The registry call failed.");
}

function tasks(d: PcToolDeps, a: Record<string, unknown>): ToolOutcome {
  const id = typeof a.id === "string" ? Number(a.id) : NaN;
  switch (a.action) {
    case "add": {
      const title = String(a.title ?? "").trim();
      if (!title) return fail("Give the task a title.");
      const t = d.tasks.add(title);
      return done(`Task ${t.id} queued: ${t.title}`);
    }
    case "list":
      return done(d.tasks.describe());
    case "start": {
      const r = d.tasks.start(id);
      if (!r.ok) return fail(r.error);
      d.status.set({ task: r.task.title });
      return done(`Task ${id} is running: ${r.task.title}`);
    }
    case "done":
    case "fail":
    case "cancel": {
      const r = d.tasks.finish(id, a.action === "done" ? "done" : a.action === "fail" ? "failed" : "cancelled", typeof a.note === "string" ? a.note : undefined);
      if (!r.ok) return fail(r.error);
      if (!d.tasks.current()) d.status.set({ task: undefined });
      return done(`Task ${id} ${a.action === "done" ? "finished" : a.action === "fail" ? "marked as failed" : "cancelled"}.`);
    }
    default:
      return fail("Unknown task action.");
  }
}
