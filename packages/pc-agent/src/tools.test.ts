import { NO_PC_PERMISSIONS, type PcPermissions } from "@friend/protocol";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Control } from "./control";
import { StatusKeeper } from "./status";
import { AgentStore } from "./store";
import { Tasks } from "./tasks";
import { runTool, type PcToolDeps } from "./tools";

const perms = (over: Partial<PcPermissions> = {}): PcPermissions => ({ ...NO_PC_PERMISSIONS, ...over });

function rig(p: PcPermissions, opts: { lease?: boolean; helper?: (op: string, args: Record<string, unknown>) => { text: string; image?: object } } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "friend-pctools-"));
  const store = new AgentStore(join(dir, "agent.db"));
  const calls: { op: string; args: Record<string, unknown> }[] = [];
  const execs: { file: string; args: string[]; env?: NodeJS.ProcessEnv }[] = [];
  let now = 1000;
  const timers: (() => void)[] = [];
  const control = new Control({ now: () => now, setTimer: (fn) => (timers.push(fn), () => {}), onChange: () => {}, countdownMs: 0 });
  if (opts.lease !== false) {
    control.start(60);
    timers[0]!(); // the countdown is over
  }
  const pushed: string[] = [];
  const status = new StatusKeeper({ store, push: (s) => pushed.push(`${s.state}|${s.task ?? ""}|${s.last ?? ""}`), now: () => now, setTimer: () => () => {} });
  const deps: PcToolDeps = {
    helper: {
      call: async (op, args) => {
        calls.push({ op, args: args ?? {} });
        const r = (opts.helper ?? (() => ({ text: `${op} ok` })))(op, args ?? {});
        return r as never;
      },
    },
    control,
    tasks: new Tasks(store),
    store,
    status,
    perms: () => p,
    exec: async (file, args, o) => {
      execs.push({ file, args, ...(o.env ? { env: o.env } : {}) });
      return { stdout: "output text", stderr: "", code: 0 };
    },
    sleep: async () => {},
  };
  return { deps, calls, execs, store, control, pushed, dir, status };
}

describe("a tool call on the PC", () => {
  it("looks and acts through the helper when a control session is running, and keeps a trail and a status line", async () => {
    const r = rig(perms({ control: true, screen: true }), { helper: (op) => (op === "snapshot" ? { text: "3 elements", image: { mime: "image/png", data: "AAAA" } } : { text: `${op} ok` }) });
    const snap = await runTool(r.deps, "pc.snapshot", { vision: true }, false);
    expect(snap).toMatchObject({ ok: true, output: "3 elements", image: { mime: "image/png" } });
    expect(await runTool(r.deps, "pc.shortcut", { keys: "ctrl+c" }, false)).toMatchObject({ ok: true, output: "shortcut ok" });
    expect(r.store.events(5).map((e) => [e.tool, e.ok])).toEqual([["pc.shortcut", true], ["pc.snapshot", true]]);
    expect(r.pushed.at(-1)).toContain("shortcut");
  });

  it("refuses the screen and the mouse without a session, even if the server let the call through", async () => {
    const r = rig(perms({ control: true, screen: true }), { lease: false });
    for (const tool of ["pc.snapshot", "pc.click", "pc.type", "pc.shortcut"]) expect(await runTool(r.deps, tool, { label: 1, text: "x", keys: "a" }, false)).toMatchObject({ ok: false, error: expect.stringMatching(/control session/i) });
    expect(r.calls).toHaveLength(0);
  });

  it("refuses what the permissions say no to", async () => {
    const r = rig(perms({ control: true }));
    expect(await runTool(r.deps, "pc.shell", { command: "dir" }, false)).toMatchObject({ ok: false, error: expect.stringMatching(/shell permission/) });
    expect(await runTool(r.deps, "pc.snapshot", {}, false)).toMatchObject({ ok: false, error: expect.stringMatching(/screen permission/) });
    expect(r.execs).toHaveLength(0);
  });

  it("never clicks or types in a password manager, a consent prompt or a bank, whatever else is allowed", async () => {
    const r = rig(perms({ control: true, screen: true }), { helper: (op) => (op === "window" ? { text: "Bitwarden" } : op === "element" ? { text: "Button|Copy password|Bitwarden" } : { text: "ok" }) });
    expect(await runTool(r.deps, "pc.click", { label: 4 }, false)).toMatchObject({ ok: false, error: expect.stringMatching(/off limits/) });
    expect(await runTool(r.deps, "pc.type", { text: "x" }, false)).toMatchObject({ ok: false, error: expect.stringMatching(/off limits/) });
    expect(await runTool(r.deps, "pc.shortcut", { keys: "ctrl+c" }, false)).toMatchObject({ ok: false });
    expect(r.calls.map((c) => c.op)).not.toContain("click");
  });

  it("the owner's own window patterns are added to the list", async () => {
    const r = rig(perms({ control: true, denyWindows: ["my secret app"] }), { helper: (op) => (op === "window" ? { text: "My Secret App - notes" } : { text: "ok" }) });
    expect(await runTool(r.deps, "pc.shortcut", { keys: "ctrl+c" }, false)).toMatchObject({ ok: false, error: expect.stringMatching(/off limits/) });
  });

  it("asks for approval when the button says it cannot be undone, by number or by position, and goes through once it was approved", async () => {
    const r = rig(perms({ control: true, screen: true }), { helper: (op) => (op === "window" ? { text: "Settings" } : op === "element" ? { text: "Button|Delete account|Settings" } : op === "at" ? { text: "MenuItem|Uninstall|Programs" } : { text: `${op} ok` }) });
    const byNumber = await runTool(r.deps, "pc.click", { label: 12 }, false);
    expect(byNumber).toMatchObject({ ok: false, needsApproval: { reason: expect.stringContaining("Delete account"), detail: expect.stringContaining("Settings") } });
    const byPlace = await runTool(r.deps, "pc.click", { x: 10, y: 20 }, false);
    expect(byPlace).toMatchObject({ ok: false, needsApproval: { reason: expect.stringContaining("Uninstall") } });
    expect(r.calls.map((c) => c.op)).not.toContain("click");
    expect(await runTool(r.deps, "pc.click", { label: 12 }, true)).toMatchObject({ ok: true });
    expect(r.calls.map((c) => c.op)).toContain("click");
  });

  it("does not need an approval for an ordinary button, and the owner's words are added to the list", async () => {
    const plain = rig(perms({ control: true }), { helper: (op) => (op === "window" ? { text: "Notepad" } : op === "element" ? { text: "Button|Save|Notepad" } : { text: "ok" }) });
    expect(await runTool(plain.deps, "pc.click", { label: 1 }, false)).toMatchObject({ ok: true });
    const mine = rig(perms({ control: true, askPatterns: ["^save$"] }), { helper: (op) => (op === "window" ? { text: "Notepad" } : op === "element" ? { text: "Button|Save|Notepad" } : { text: "ok" }) });
    expect(await runTool(mine.deps, "pc.click", { label: 1 }, false)).toMatchObject({ ok: false, needsApproval: {} });
  });

  it("passes a helper failure on as the error, such as text that did not arrive", async () => {
    const r = rig(perms({ control: true }), {});
    r.deps.helper.call = async () => {
      throw new Error("The text did not arrive");
    };
    expect(await runTool(r.deps, "pc.shortcut", { keys: "a" }, false)).toMatchObject({ ok: false, error: "The text did not arrive" });
    expect(r.store.events(1)[0]).toMatchObject({ ok: false });
  });
});

describe("shell, files, processes and the registry", () => {
  it("runs PowerShell with a time limit and gives back what it printed", async () => {
    const r = rig(perms({ shell: true }), { lease: false });
    expect(await runTool(r.deps, "pc.shell", { command: "Get-Date", timeoutSeconds: 5 }, false)).toMatchObject({ ok: true, output: "output text" });
    expect(r.execs[0]).toMatchObject({ file: "powershell.exe" });
    expect(r.execs[0]!.args.join(" ")).toContain("Get-Date");
  });

  it("reads, writes, lists, searches and deletes files only inside the allowed folders", async () => {
    const r = rig(perms({ files: "write", folders: [] }), { lease: false });
    const shop = join(r.dir, "shop");
    mkdirSync(join(shop, "src"), { recursive: true });
    writeFileSync(join(shop, "src", "readme.md"), "hello");
    r.deps.perms = () => perms({ files: "write", folders: [shop] });
    expect(await runTool(r.deps, "pc.files", { action: "read", path: join(shop, "src", "readme.md") }, false)).toMatchObject({ ok: true, output: "hello" });
    expect(await runTool(r.deps, "pc.files", { action: "write", path: join(shop, "new", "a.txt"), content: "x" }, false)).toMatchObject({ ok: true });
    expect(readFileSync(join(shop, "new", "a.txt"), "utf8")).toBe("x");
    expect((await runTool(r.deps, "pc.files", { action: "list", path: shop }, false)) as { output: string }).toMatchObject({ output: expect.stringContaining("src") });
    expect((await runTool(r.deps, "pc.files", { action: "search", path: shop, pattern: "READ" }, false)) as { output: string }).toMatchObject({ output: expect.stringContaining("readme.md") });
    expect(await runTool(r.deps, "pc.files", { action: "read", path: join(r.dir, "outside.txt") }, false)).toMatchObject({ ok: false, error: expect.stringMatching(/outside/i) });
    expect(await runTool(r.deps, "pc.files", { action: "delete", path: join(shop, "new") }, false)).toMatchObject({ ok: true });
    expect(existsSync(join(shop, "new"))).toBe(false);
  });

  it("will not read through a junction that points out of the allowed folder", async () => {
    const r = rig(perms({ files: "read" }), { lease: false });
    const shop = join(r.dir, "shop");
    const secret = join(r.dir, "secret");
    mkdirSync(shop);
    mkdirSync(secret);
    writeFileSync(join(secret, "key.txt"), "private");
    const { symlinkSync } = await import("node:fs");
    try {
      symlinkSync(secret, join(shop, "link"), "junction");
    } catch {
      return; // links cannot be made here
    }
    r.deps.perms = () => perms({ files: "read", folders: [shop] });
    expect(await runTool(r.deps, "pc.files", { action: "read", path: join(shop, "link", "key.txt") }, false)).toMatchObject({ ok: false, error: expect.stringMatching(/outside/i) });
  });

  it("passes the registry and process arguments as environment variables, never inside the command text", async () => {
    const r = rig(perms({ registry: true, process: true }), { lease: false });
    await runTool(r.deps, "pc.registry", { action: "write", key: "HKCU:\\Software\\X'; Remove-Item C:\\ #", name: "a", value: "1", type: "DWord" }, false);
    const reg = r.execs.at(-1)!;
    expect(reg.args.join(" ")).not.toContain("Remove-Item C:");
    expect(reg.env).toMatchObject({ FR_KEY: "HKCU:\\Software\\X'; Remove-Item C:\\ #", FR_VALUE: "1", FR_TYPE: "DWord" });
    await runTool(r.deps, "pc.process", { action: "end", name: "notepad; calc" }, false);
    expect(r.execs.at(-1)!.args.join(" ")).not.toContain("calc");
    expect(r.execs.at(-1)!.env).toMatchObject({ FR_NAME: "notepad; calc" });
  });
});

describe("the tasks of a PC", () => {
  it("queue, run one at a time, show in the status, and finish", async () => {
    const r = rig(perms({ control: true }));
    expect(await runTool(r.deps, "pc.tasks", { action: "add", title: "update the report" }, false)).toMatchObject({ ok: true, output: expect.stringContaining("Task 1") });
    await runTool(r.deps, "pc.tasks", { action: "add", title: "install the printer" }, false);
    expect(await runTool(r.deps, "pc.tasks", { action: "start", id: "1" }, false)).toMatchObject({ ok: true });
    expect(r.status.current().task).toBe("update the report");
    expect(await runTool(r.deps, "pc.tasks", { action: "start", id: "2" }, false)).toMatchObject({ ok: false, error: expect.stringMatching(/running/) });
    expect(await runTool(r.deps, "pc.tasks", { action: "done", id: "1", note: "saved" }, false)).toMatchObject({ ok: true });
    expect(r.status.current().task).toBeUndefined();
    expect(((await runTool(r.deps, "pc.tasks", { action: "list" }, false)) as { output: string }).output).toContain("install the printer");
  });
});

describe("tools that do not exist on this PC yet", () => {
  it("says so for terminals when there is no terminal support", async () => {
    const r = rig(perms({ shell: true, folders: ["D:\\shop"] }), { lease: false });
    expect(await runTool(r.deps, "pc.term.list", {}, false)).toMatchObject({ ok: false, error: expect.stringMatching(/not available/) });
  });
});
