import { NO_PC_PERMISSIONS, type PcDown, type ServerMsg } from "@friend/protocol";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { Approvals } from "../approvals";
import { Agent } from "../agent/loop";
import { Audit } from "../audit";
import { loadConfig } from "../config";
import { openDb } from "../db";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import { StageState } from "../stage";
import { PcHub, type PcSocket } from "./hub";
import { PcStore } from "./store";
import { PcTools } from "./tools";

const done = { type: "done" as const };
const call = (name: string, args: unknown, id = "1") => ({ type: "tool_call" as const, id, name, args });

class FakePc extends EventEmitter implements PcSocket {
  got: PcDown[] = [];
  answer: (m: Extract<PcDown, { type: "tool.exec" }>) => object = (m) => ({ type: "tool.result", id: m.id, result: { output: `${m.tool} ok`, truncated: false } });
  send(data: string): void {
    const m = JSON.parse(data) as PcDown;
    this.got.push(m);
    if (m.type === "tool.exec") queueMicrotask(() => this.emit("message", Buffer.from(JSON.stringify(this.answer(m)))));
  }
  close(): void {
    this.emit("close");
  }
}

function build(provider: FakeProvider, approve = true) {
  const dir = mkdtempSync(join(tmpdir(), "friend-pcagent-"));
  const db = openDb(dir);
  const config = loadConfig(dir);
  const store = new PcStore(db);
  const hub = new PcHub({ store });
  const made = store.create({ name: "Office", permissions: { ...NO_PC_PERMISSIONS, control: true, screen: true, shell: true, folders: ["D:\\shop"] } });
  if ("error" in made) throw new Error(made.error);
  const pc = new FakePc();
  hub.attach(made.pc.id, pc);
  const request = vi.fn(async (_r: unknown) => (approve ? { approved: true } : { approved: false, reason: "denied" }));
  const agent = new Agent({
    provider,
    policy: new PolicyEngine(db, config),
    approvals: { request } as unknown as Approvals,
    devices: { exec: vi.fn(), hasOnline: () => true, targetName: () => "pc" } as never,
    stage: new StageState(),
    db,
    audit: new Audit(db),
    config,
    assistantName: () => "Jarvis",
    pcs: new PcTools({ hub, store, audit: new Audit(db), extraPatterns: () => [] }),
  });
  return { agent, pc, request, hub, id: made.pc.id };
}
const ctx = (trust: "owner" | "guest" = "owner") => ({ trust, emit: (_m: ServerMsg) => {}, ip: "1.1.1.1" });
const results = (p: FakeProvider) => JSON.stringify(p.calls.slice(1).map((c) => c.messages.at(-1)));

describe("the assistant using a Windows PC", () => {
  it("asks once to start a control session, then looks and acts without more cards", async () => {
    const p = new FakeProvider([[call("pc.control", { action: "start", minutes: 10 }, "a"), done], [call("pc.snapshot", {}, "b"), call("pc.click", { label: 4 }, "c"), done], [{ type: "text_delta", text: "done" }, done]]);
    const b = build(p);
    await b.agent.runTurn("open the settings on the office pc", ctx());
    expect(b.request).toHaveBeenCalledTimes(1); // the control session; nothing after it
    expect(b.request.mock.calls[0]![0]).toMatchObject({ tool: "pc.control", device: "Office" });
    const sent = b.pc.got.filter((m) => m.type === "tool.exec").map((m) => (m as { tool: string }).tool);
    expect(sent).toEqual(["pc.snapshot", "pc.click"]);
    expect(results(p)).toContain("pc.snapshot ok");
  });

  it("is refused without a session, in words the model can act on", async () => {
    const p = new FakeProvider([[call("pc.click", { label: 1 }), done], [done]]);
    const b = build(p);
    await b.agent.runTurn("click it", ctx());
    expect(results(p)).toMatch(/control session/);
    expect(b.pc.got.filter((m) => m.type === "tool.exec")).toHaveLength(0);
  });

  it("asks the owner when the PC says a button looks critical, and does not click when they say no", async () => {
    const p = new FakeProvider([[call("pc.control", { action: "start" }, "a"), done], [call("pc.click", { label: 9 }, "b"), done], [done]]);
    const b = build(p, false);
    await b.agent.runTurn("x", ctx());
    expect(b.request).toHaveBeenCalledTimes(1);
    expect(results(p)).toMatch(/did not approve/);

    const q = new FakeProvider([[call("pc.click", { label: 9 }, "b"), done], [done]]);
    const c = build(q, true);
    c.hub.startLease(c.id, 10);
    let first = true;
    c.pc.answer = (m) => {
      if (first && !(m as { approved?: boolean }).approved) {
        first = false;
        return { type: "tool.error", id: m.id, error: "needs approval", needsApproval: { reason: "A button called Delete account", detail: "Settings, element 9" } };
      }
      return { type: "tool.result", id: m.id, result: { output: "clicked", truncated: false } };
    };
    await c.agent.runTurn("x", ctx());
    expect(c.request).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(c.request.mock.calls[0]![0])).toContain("Delete account");
    expect(results(q)).toContain("clicked");
  });

  it("answers a shell command that goes outside the allowed folders with a refusal, and never asks", async () => {
    const p = new FakeProvider([[call("pc.files", { action: "read", path: "C:\\Users\\x\\secret.txt" }), done], [done]]);
    const b = build(p);
    await b.agent.runTurn("read my secrets", ctx());
    expect(b.request).not.toHaveBeenCalled();
    expect(results(p)).toMatch(/files permission|outside/i);
  });

  it("is for the owner only", async () => {
    const p = new FakeProvider([[call("pc.list", {}), done], [done]]);
    const b = build(p);
    await b.agent.runTurn("list", ctx("guest"));
    expect(results(p)).toMatch(/Only the owner/);
  });
});
