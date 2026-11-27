import { NO_PC_PERMISSIONS, type PcDown, type PcPermissions } from "@friend/protocol";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { Audit } from "../audit";
import { openDb } from "../db";
import { PcHub, type PcSocket } from "./hub";
import { PcStore } from "./store";
import { PcTools } from "./tools";

class FakePc extends EventEmitter implements PcSocket {
  sent: PcDown[] = [];
  /** How the PC answers each tool: the output, or an error, or a request for approval. */
  answer: (m: Extract<PcDown, { type: "tool.exec" }>) => object = (m) => ({ type: "tool.result", id: m.id, result: { output: `${m.tool} done`, truncated: false } });
  send(data: string): void {
    const m = JSON.parse(data) as PcDown;
    this.sent.push(m);
    if (m.type === "tool.exec") queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify(this.answer(m)))));
  }
  close(): void {
    this.emit("close");
  }
}

const perms = (over: Partial<PcPermissions> = {}): PcPermissions => ({ ...NO_PC_PERMISSIONS, ...over });

function rig(pcs: Record<string, PcPermissions>, online: string[]) {
  const db = openDb(mkdtempSync(join(tmpdir(), "friend-pctools-")));
  const store = new PcStore(db);
  const hub = new PcHub({ store });
  const audit = new Audit(db);
  const sockets: Record<string, FakePc> = {};
  for (const [name, p] of Object.entries(pcs)) {
    const made = store.create({ name, permissions: p });
    if ("error" in made) throw new Error(made.error);
    if (online.includes(name)) {
      const ws = new FakePc();
      sockets[name] = ws;
      hub.attach(made.pc.id, ws);
    }
  }
  const tools = new PcTools({ hub, store, audit, extraPatterns: () => [] });
  const ids = Object.fromEntries(store.list().map((p) => [p.name, p.id]));
  return { tools, hub, store, audit, sockets, ids };
}
const ask = (yes = true) => vi.fn(async () => yes);
/** Prepares and runs a call the way the assistant's loop does. */
async function call(r: ReturnType<typeof rig>, name: string, args: object, approve = ask()) {
  const prep = r.tools.prepare(name, args);
  if ("error" in prep) return { refused: prep.error };
  return { tier: prep.tier, pcName: prep.pcName, result: await prep.run(approve, new AbortController().signal), approve };
}

describe("the assistant's PC tools", () => {
  it("lists the PCs with their state", async () => {
    const r = rig({ Office: perms(), Home: perms() }, ["Office"]);
    r.sockets.Office!.emit("message", Buffer.from(JSON.stringify({ type: "status", status: { state: "idle", task: "backup", at: 1 } })));
    const out = (await call(r, "pc.list", {})) as { result: { text: string } };
    expect(out.result.text).toMatch(/Office.*online.*idle.*backup/s);
    expect(out.result.text).toMatch(/Home.*offline/s);
  });

  it("asks which PC when there are several, and refuses an offline or unknown one, in a sentence", async () => {
    const r = rig({ Office: perms({ shell: true }), Home: perms({ shell: true }) }, ["Office", "Home"]);
    expect(await call(r, "pc.shell", { command: "dir" })).toMatchObject({ refused: expect.stringMatching(/Which PC\?/) });
    expect(await call(r, "pc.shell", { pc: "Garage", command: "dir" })).toMatchObject({ refused: expect.stringMatching(/no PC called Garage/i) });
    const solo = rig({ Office: perms({ shell: true }), Home: perms({ shell: true }) }, ["Home"]);
    expect(await call(solo, "pc.shell", { pc: "Office", command: "dir" })).toMatchObject({ refused: expect.stringMatching(/offline/) });
    expect(await call(solo, "pc.shell", { command: "dir" })).toMatchObject({ pcName: "Home", tier: "T1" });
  });

  it("goes by the permissions: a refusal says what to switch on, an allowed call goes through without a card, a critical one asks", async () => {
    const r = rig({ Office: perms({ shell: true }) }, ["Office"]);
    expect(await call(r, "pc.files", { action: "read", path: "D:\\a" })).toMatchObject({ refused: expect.stringMatching(/files permission/) });
    const plain = await call(r, "pc.shell", { command: "Get-Date" });
    expect(plain).toMatchObject({ tier: "T1", result: { isError: false, text: expect.stringContaining("pc.shell done") } });
    const risky = await call(r, "pc.shell", { command: "Remove-Item D:\\x -Recurse" });
    expect(risky).toMatchObject({ tier: "T2" });
  });

  it("sends the tool without the pc name and with the permissions the server holds", async () => {
    const r = rig({ Office: perms({ shell: true }) }, ["Office"]);
    await call(r, "pc.shell", { pc: "Office", command: "dir" });
    const sent = r.sockets.Office!.sent.find((m) => m.type === "tool.exec") as Extract<PcDown, { type: "tool.exec" }>;
    expect(sent.args).toEqual({ command: "dir" });
    expect(sent.permissions).toMatchObject({ shell: true });
  });

  it("starts a control session (which asks) and gates the screen and the mouse on it", async () => {
    const r = rig({ Office: perms({ control: true, screen: true }) }, ["Office"]);
    expect(await call(r, "pc.snapshot", {})).toMatchObject({ refused: expect.stringMatching(/control session/) });
    const start = await call(r, "pc.control", { action: "start", minutes: 15 });
    expect(start).toMatchObject({ tier: "T2" });
    expect((start as { result: { text: string } }).result.text).toMatch(/started|running/i);
    expect(r.sockets.Office!.sent.find((m) => m.type === "lease.start")).toMatchObject({ minutes: 15 });
    expect(await call(r, "pc.snapshot", {})).toMatchObject({ tier: "T1" });
    r.sockets.Office!.emit("message", Buffer.from(JSON.stringify({ type: "human.input" })));
    expect(await call(r, "pc.click", { label: 3 })).toMatchObject({ refused: expect.stringMatching(/control session/) });
    const status = (await call(r, "pc.control", { action: "status" })) as { result: { text: string } };
    expect(status.result.text).toMatch(/paused/i);
    const stop = (await call(r, "pc.control", { action: "stop" })) as { result: { text: string } };
    expect(stop.result.text).toMatch(/ended|stopped/i);
  });

  it("asks the owner when the PC finds something critical on its own screen, and tries again only if they approve", async () => {
    const r = rig({ Office: perms({ control: true, screen: true }) }, ["Office"]);
    r.hub.startLease(r.ids.Office!, 10);
    let first = true;
    r.sockets.Office!.answer = (m) => {
      const approved = (m as { approved?: boolean }).approved;
      if (first && !approved) {
        first = false;
        return { type: "tool.error", id: m.id, error: "needs approval", needsApproval: { reason: "A button called Delete account", detail: "Settings window, element 12" } };
      }
      return { type: "tool.result", id: m.id, result: { output: "clicked", truncated: false } };
    };
    const yes = ask(true);
    const done = await call(r, "pc.click", { label: 12 }, yes);
    expect(yes).toHaveBeenCalledWith("A button called Delete account", "Settings window, element 12");
    expect(done).toMatchObject({ result: { isError: false, text: "clicked" } });

    first = true;
    const no = ask(false);
    const denied = await call(r, "pc.click", { label: 12 }, no);
    expect(denied).toMatchObject({ result: { isError: true, text: expect.stringMatching(/did not approve/) } });
    expect(r.sockets.Office!.sent.filter((m) => m.type === "tool.exec" && (m as { approved?: boolean }).approved)).toHaveLength(1); // only the approved one carried it
  });

  it("passes a picture on, and writes one audit line per call with the PC and the tool but never the typed text", async () => {
    const r = rig({ Office: perms({ control: true, screen: true }) }, ["Office"]);
    r.hub.startLease(r.ids.Office!, 10);
    r.sockets.Office!.answer = (m) => ({ type: "tool.result", id: m.id, result: { output: "ok", truncated: false, image: { mime: "image/png", data: "AAAA" } } });
    const shot = (await call(r, "pc.snapshot", {})) as { result: { image?: { mime: string } } };
    expect(shot.result.image).toMatchObject({ mime: "image/png" });
    await call(r, "pc.type", { text: "my secret password", label: 2 });
    const entries = r.audit.list(50).filter((e) => e.kind === "pc.call");
    expect(entries.length).toBe(2);
    const dump = JSON.stringify(entries);
    expect(dump).toContain("Office");
    expect(dump).toContain("pc.type");
    expect(dump).not.toContain("my secret password");
    expect(dump).toContain('"chars":18');
  });

  it("answers for a PC that goes quiet or disconnects", async () => {
    const r = rig({ Office: perms({ shell: true }) }, ["Office"]);
    r.sockets.Office!.send = () => {
      queueMicrotask(() => r.sockets.Office!.emit("close"));
    };
    const out = (await call(r, "pc.shell", { command: "dir" })) as { result: { isError: boolean; text: string } };
    expect(out.result.isError).toBe(true);
    expect(out.result.text).toMatch(/disconnected/i);
  });
});
