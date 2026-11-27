import { NO_PC_PERMISSIONS, type PcDown } from "@friend/protocol";
import { EventEmitter } from "node:events";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { openDb } from "../db";
import { PcHub, type PcSocket } from "./hub";
import { PcStore } from "./store";

class FakeSocket extends EventEmitter implements PcSocket {
  sent: PcDown[] = [];
  closed: { code?: number; reason?: string } | null = null;
  send(data: string): void {
    this.sent.push(JSON.parse(data) as PcDown);
  }
  close(code?: number, reason?: string): void {
    this.closed = { code: code ?? 1000, reason: reason ?? "" };
    this.emit("close");
  }
  /** What the PC says. */
  say(m: object): void {
    this.emit("message", Buffer.from(JSON.stringify(m)));
  }
}

function rig() {
  const db = openDb(mkdtempSync(join(tmpdir(), "friend-pchub-")));
  let now = 5_000;
  const store = new PcStore(db, () => now);
  const hub = new PcHub({ store, clock: () => now });
  const add = (name: string) => {
    const made = store.create({ name, permissions: NO_PC_PERMISSIONS });
    if ("error" in made) throw new Error(made.error);
    return made.pc.id;
  };
  const connect = (id: number) => {
    const ws = new FakeSocket();
    hub.attach(id, ws);
    ws.say({ type: "hello", os: "Windows 11", host: "HOST", version: "0.1.97" });
    return ws;
  };
  return { store, hub, add, connect, advance: (ms: number) => (now += ms) };
}

describe("PCs that are connected", () => {
  it("are online while their socket is open, and offline after", () => {
    const r = rig();
    const id = r.add("Office");
    expect(r.hub.isOnline(id)).toBe(false);
    const ws = r.connect(id);
    expect(r.hub.isOnline(id)).toBe(true);
    expect(r.store.get(id)).toMatchObject({ os: "Windows 11", host: "HOST" });
    ws.close();
    expect(r.hub.isOnline(id)).toBe(false);
  });

  it("are found by name: the only one online without a name, a question when several, a sentence when offline or unknown", () => {
    const r = rig();
    const a = r.add("Office");
    const b = r.add("Home laptop");
    r.add("Shed");
    expect(r.hub.resolve()).toMatchObject({ error: expect.stringMatching(/No PC is online/) });
    r.connect(a);
    expect(r.hub.resolve()).toMatchObject({ pcId: a, name: "Office" });
    r.connect(b);
    expect(r.hub.resolve()).toMatchObject({ ask: expect.stringMatching(/Office.*Home laptop|Home laptop.*Office/) });
    expect(r.hub.resolve("home LAPTOP")).toMatchObject({ pcId: b });
    expect(r.hub.resolve("Shed")).toMatchObject({ error: expect.stringMatching(/offline/i) });
    expect(r.hub.resolve("Garage")).toMatchObject({ error: expect.stringMatching(/no PC called Garage/i) });
    expect(r.hub.resolve("off")).toMatchObject({ pcId: a }); // a unique beginning is enough
  });

  it("run a tool and give back the result, an error, or a request for the owner's approval", async () => {
    const r = rig();
    const id = r.add("Office");
    const ws = r.connect(id);
    const p = r.hub.exec(id, "pc.snapshot", { vision: true }, 1000);
    const sent = ws.sent.at(-1) as Extract<PcDown, { type: "tool.exec" }>;
    expect(sent).toMatchObject({ type: "tool.exec", tool: "pc.snapshot", args: { vision: true } });
    ws.say({ type: "tool.result", id: sent.id, result: { output: "3 elements", truncated: false } });
    expect(await p).toEqual({ ok: true, output: "3 elements", truncated: false });

    const q = r.hub.exec(id, "pc.click", { label: 9 }, 1000);
    ws.say({ type: "tool.error", id: (ws.sent.at(-1) as { id: string }).id, error: "needs approval", needsApproval: { reason: "A button called Delete", detail: "Delete account" } });
    expect(await q).toMatchObject({ ok: false, needsApproval: { reason: "A button called Delete" } });

    const again = r.hub.exec(id, "pc.click", { label: 9 }, 1000, { approved: true });
    expect(ws.sent.at(-1)).toMatchObject({ approved: true });
    ws.say({ type: "tool.result", id: (ws.sent.at(-1) as { id: string }).id, result: { output: "clicked", truncated: false } });
    expect(await again).toMatchObject({ ok: true });
  });

  it("times out, and fails every waiting call when the PC goes away", async () => {
    const r = rig();
    const id = r.add("Office");
    const ws = r.connect(id);
    expect(await r.hub.exec(id, "pc.wait", {}, 20)).toMatchObject({ ok: false, error: expect.stringMatching(/timed out/) });
    const waiting = r.hub.exec(id, "pc.snapshot", {}, 5000);
    ws.close();
    expect(await waiting).toMatchObject({ ok: false, error: expect.stringMatching(/disconnected/) });
    expect(await r.hub.exec(id, "pc.snapshot", {}, 100)).toMatchObject({ ok: false, error: expect.stringMatching(/not connected/) });
  });

  it("ignore what is not a valid message, and a result nobody asked for", async () => {
    const r = rig();
    const id = r.add("Office");
    const ws = r.connect(id);
    ws.emit("message", Buffer.from("not json"));
    ws.say({ type: "nope" });
    ws.say({ type: "tool.result", id: "nobody", result: { output: "x", truncated: false } });
    expect(r.hub.isOnline(id)).toBe(true);
  });
});

describe("a control session", () => {
  it("is one at a time per PC, can be asked for a number of minutes, and ends on request", async () => {
    const r = rig();
    const a = r.add("Office");
    const b = r.add("Home");
    const wa = r.connect(a);
    r.connect(b);
    const first = r.hub.startLease(a, 10);
    expect(first).toMatchObject({ ok: true });
    expect(wa.sent.at(-1)).toMatchObject({ type: "lease.start", minutes: 10 });
    expect(r.hub.leaseActive(a)).toBe(true);
    expect(r.hub.startLease(a, 5)).toMatchObject({ ok: false, error: expect.stringMatching(/already/) });
    expect(r.hub.leaseActive(b)).toBe(false); // another PC has its own
    r.hub.endLease(a, "the owner stopped it");
    expect(wa.sent.at(-1)).toMatchObject({ type: "lease.end" });
    expect(r.hub.leaseActive(a)).toBe(false);
  });

  it("pauses when the person at the PC uses the mouse or keyboard, and starts again only when asked", () => {
    const r = rig();
    const id = r.add("Office");
    const ws = r.connect(id);
    r.hub.startLease(id, 10);
    ws.say({ type: "human.input" });
    expect(r.hub.leaseActive(id)).toBe(false);
    expect(r.hub.leaseInfo(id)).toMatchObject({ paused: true });
    expect(r.hub.startLease(id, 10)).toMatchObject({ ok: true }); // asked again: the PC counts down 3 seconds itself
    expect(r.hub.leaseActive(id)).toBe(true);
  });

  it("ends when it runs out, when the PC says so, and when the PC disconnects", () => {
    const r = rig();
    const id = r.add("Office");
    const ws = r.connect(id);
    r.hub.startLease(id, 2);
    r.advance(121_000);
    expect(r.hub.leaseActive(id)).toBe(false);
    r.hub.startLease(id, 10);
    ws.say({ type: "lease.ended", reason: "hotkey" });
    expect(r.hub.leaseActive(id)).toBe(false);
    r.hub.startLease(id, 10);
    ws.close();
    expect(r.hub.leaseActive(id)).toBe(false);
    expect(r.hub.startLease(id, 10)).toMatchObject({ ok: false, error: expect.stringMatching(/not connected/) });
  });
});

describe("status and revoking", () => {
  it("keeps the PC's status record, tells listeners, and keeps the last one while it is offline", () => {
    const r = rig();
    const id = r.add("Office");
    const seen: string[] = [];
    r.hub.onChange((pcId, why) => seen.push(`${pcId}:${why}`));
    const ws = r.connect(id);
    ws.say({ type: "status", status: { state: "controlling", task: "update the report", at: 1 } });
    expect(r.hub.statusOf(id)).toMatchObject({ state: "controlling", task: "update the report" });
    expect(r.store.get(id)!.status).toMatchObject({ state: "controlling" });
    ws.close();
    expect(r.store.get(id)!.status).toMatchObject({ task: "update the report" });
    expect(seen).toEqual(expect.arrayContaining([`${id}:online`, `${id}:status`, `${id}:offline`]));
  });

  it("closes the socket at once when the PC is revoked, ends its session and fails its waiting calls", async () => {
    const r = rig();
    const id = r.add("Office");
    const ws = r.connect(id);
    r.hub.startLease(id, 10);
    const waiting = r.hub.exec(id, "pc.snapshot", {}, 5000);
    r.hub.revoke(id);
    expect(ws.sent.at(-1)).toMatchObject({ type: "revoke" });
    expect(ws.closed?.code).toBe(4403);
    expect(await waiting).toMatchObject({ ok: false });
    expect(r.hub.leaseActive(id)).toBe(false);
  });

  it("a new connection of the same PC replaces the old one", () => {
    const r = rig();
    const id = r.add("Office");
    const first = r.connect(id);
    const second = r.connect(id);
    expect(first.closed?.code).toBe(4000);
    expect(r.hub.isOnline(id)).toBe(true);
    first.say({ type: "status", status: { state: "idle", at: 9 } }); // a late message from the old socket changes nothing
    expect(r.hub.statusOf(id)).toBeNull();
    second.close();
    expect(r.hub.isOnline(id)).toBe(false);
  });
});
