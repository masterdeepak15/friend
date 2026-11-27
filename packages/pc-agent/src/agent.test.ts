import { NO_PC_PERMISSIONS, type PcDown, type PcUp } from "@friend/protocol";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PcAgent } from "./agent";
import type { WsLike } from "./link";
import { AgentStore } from "./store";

class FakeWs implements WsLike {
  sent: PcUp[] = [];
  closed = false;
  private handlers: Record<string, ((...a: never[]) => void)[]> = {};
  send(d: string): void {
    this.sent.push(JSON.parse(d) as PcUp);
  }
  close(): void {
    this.closed = true;
  }
  on(ev: string, cb: (...a: never[]) => void): void {
    (this.handlers[ev] ??= []).push(cb);
  }
  fire(ev: string, ...a: unknown[]): void {
    for (const cb of this.handlers[ev] ?? []) (cb as (...x: unknown[]) => void)(...a);
  }
  /** Friend says something to the PC. */
  tell(m: PcDown): void {
    this.fire("message", Buffer.from(JSON.stringify(m)));
  }
}

const flush = () => new Promise<void>((r) => setTimeout(r, 5));

function rig(opts: { signedIn?: boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "friend-pcagent-"));
  const store = new AgentStore(join(dir, "agent.db"));
  let now = 100_000;
  const timers: { at: number; fn: () => void; live: boolean }[] = [];
  const helperCalls: { op: string; args: Record<string, unknown> }[] = [];
  const sockets: { url: string; token: string; ws: FakeWs }[] = [];
  const shown: string[] = [];
  const events: string[] = [];
  let approved = false;
  const verifier: { challenge?: string } = {};
  const fetchFake = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, string>;
    const reply = (status: number, b: object) => new Response(JSON.stringify(b), { status });
    if (path === "/api/pc/enroll/start") {
      verifier.challenge = body.challenge;
      return reply(200, { deviceCode: "d".repeat(30), userCode: "ABCD-2345", verifyPath: "/pc/approve?code=ABCD-2345", interval: 1, expiresIn: 600 });
    }
    if (path === "/api/pc/enroll/token") {
      if (createHash("sha256").update(body.verifier!).digest("base64url") !== verifier.challenge) return reply(400, { error: "invalid" });
      return approved ? reply(200, { access: "ACCESS1", refresh: "REFRESH1".padEnd(30, "x"), pcId: 3, expiresIn: 3600 }) : reply(202, { pending: true });
    }
    if (path === "/api/pc/token/refresh") return reply(200, { access: "ACCESS2", refresh: "REFRESH2".padEnd(30, "x"), pcId: 3, expiresIn: 3600 });
    return reply(404, {});
  }) as unknown as typeof fetch;
  const helper = {
    call: async (op: string, args: Record<string, unknown> = {}) => {
      helperCalls.push({ op, args });
      if (op === "seal") return { text: Buffer.from(String(args.text)).toString("base64") };
      if (op === "unseal") return { text: Buffer.from(String(args.text), "base64").toString() };
      if (op === "window") return { text: "Notepad" };
      if (op === "snapshot") return { text: "Active window: Notepad", image: { mime: "image/png", data: "AAAA" } };
      return { text: `${op} ok` };
    },
    stop: () => {},
  };
  const agent = new PcAgent({
    store,
    helper: helper as never,
    server: "https://maya.example.com",
    version: "0.1.97",
    os: "Windows 11",
    host: "OFFICE-PC",
    enrollmentId: opts.signedIn ? undefined : "enroll-1",
    connect: (url, token) => {
      const ws = new FakeWs();
      sockets.push({ url, token, ws });
      return ws;
    },
    show: (url, code) => shown.push(`${url} ${code}`),
    fetch: fetchFake,
    now: () => now,
    setTimer: (fn, ms) => {
      const t = { at: now + ms, fn, live: true };
      timers.push(t);
      return () => (t.live = false);
    },
    onRevoked: () => events.push("revoked"),
    onUpdate: (u, h) => events.push(`update ${u} ${h.slice(0, 4)}`),
  });
  const advance = (ms: number) => {
    const to = now + ms;
    for (;;) {
      const next = timers.filter((t) => t.live && t.at <= to).sort((a, b) => a.at - b.at)[0];
      if (!next) break;
      next.live = false;
      now = next.at;
      next.fn();
    }
    now = to;
  };
  return { agent, store, sockets, helperCalls, shown, events, advance, approve: () => (approved = true), ws: () => sockets.at(-1)!.ws };
}

/** An agent that already signed in and is connected. */
async function connected() {
  const r = rig();
  r.approve();
  await r.agent.start();
  // the first sign-in polls after a pause of one second: the fake sleeps for real, so wait for the socket
  for (let i = 0; i < 50 && r.sockets.length === 0; i++) await flush();
  r.ws().fire("open");
  await flush();
  return r;
}
const sentTypes = (r: Awaited<ReturnType<typeof connected>>) => r.ws().sent.map((m) => m.type);

describe("the PC agent", () => {
  it("signs in with the owner's approval, then connects with its access token and says who it is", async () => {
    const r = await connected();
    expect(r.shown[0]).toBe("https://maya.example.com/pc/approve?code=ABCD-2345 ABCD-2345");
    expect(r.sockets[0]).toMatchObject({ url: "wss://maya.example.com/pc", token: "ACCESS1" });
    expect(r.ws().sent[0]).toMatchObject({ type: "hello", os: "Windows 11", host: "OFFICE-PC", version: "0.1.97" });
    expect(sentTypes(r)).toContain("status");
    expect(await r.agent.session.signedIn()).toBe(true);
    await r.agent.stop();
  }, 20_000);

  it("a PC that signed in before connects without asking again", async () => {
    const first = await connected();
    await first.agent.stop();
    const store = first.store;
    const again = new PcAgent({
      store,
      helper: { call: async (op: string, args: Record<string, unknown> = {}) => ({ text: op === "unseal" ? Buffer.from(String(args.text), "base64").toString() : op === "seal" ? Buffer.from(String(args.text)).toString("base64") : "ok" }), stop() {} } as never,
      server: "https://maya.example.com",
      version: "0.1.97",
      os: "Windows 11",
      host: "OFFICE-PC",
      connect: () => new FakeWs(),
      show: () => {
        throw new Error("must not ask again");
      },
      fetch: (async () => new Response(JSON.stringify({ access: "A9", refresh: "R9".padEnd(30, "x"), pcId: 3, expiresIn: 3600 }), { status: 200 })) as never,
    });
    await again.start();
    await again.stop();
  }, 20_000);

  it("a PC that never signed in and has no install link says what to do", async () => {
    const r = rig();
    const agent = new PcAgent({ store: r.store, helper: { call: async () => ({ text: "" }), stop() {} } as never, server: "https://x", version: "1", os: "w", host: "h", connect: () => new FakeWs(), show: () => {} });
    await expect(agent.start()).rejects.toThrow(/install command/);
  });

  it("does what Friend asks only under a control session: a session starts after a countdown, and a tool call then works", async () => {
    const r = await connected();
    r.ws().tell({ type: "permissions", permissions: { ...NO_PC_PERMISSIONS, control: true, screen: true } });
    r.ws().tell({ type: "tool.exec", id: "a", tool: "pc.snapshot", args: {} });
    await flush();
    expect(r.ws().sent.find((m) => m.type === "tool.error")).toMatchObject({ id: "a", error: expect.stringMatching(/control session/) });

    r.ws().tell({ type: "lease.start", id: "l1", minutes: 10 });
    await flush();
    expect(r.agent.control.phase()).toBe("countdown");
    expect(r.helperCalls.find((c) => c.op === "overlay" && c.args.show === true)).toBeTruthy();
    r.advance(3000);
    expect(r.agent.control.phase()).toBe("active");
    r.ws().tell({ type: "tool.exec", id: "b", tool: "pc.snapshot", args: {} });
    await flush();
    expect(r.ws().sent.find((m) => m.type === "tool.result" && m.id === "b")).toMatchObject({ result: { output: "Active window: Notepad", image: { mime: "image/png" } } });
    expect(r.agent.status.current()).toMatchObject({ state: "controlling" });
    await r.agent.stop();
  }, 20_000);

  it("the person at the PC using the mouse pauses it and Friend is told; the hotkey ends it and Friend is told", async () => {
    const r = await connected();
    r.ws().tell({ type: "permissions", permissions: { ...NO_PC_PERMISSIONS, control: true } });
    r.ws().tell({ type: "lease.start", id: "l1" });
    await flush();
    r.advance(3000);
    r.agent.onHelperEvent("human", {});
    expect(r.agent.control.phase()).toBe("paused");
    expect(sentTypes(r)).toContain("human.input");
    expect(r.agent.status.current().state).toBe("paused");
    r.ws().tell({ type: "lease.start", id: "l2" });
    await flush();
    r.advance(3000);
    r.agent.onHelperEvent("hotkey", {});
    expect(r.agent.control.phase()).toBe("idle");
    expect(r.ws().sent.filter((m) => m.type === "lease.ended").length).toBeGreaterThan(0);
    expect(r.helperCalls.filter((c) => c.op === "overlay").at(-1)!.args.show).toBe(false);
    await r.agent.stop();
  }, 20_000);

  it("stops controlling the moment the connection to Friend is lost", async () => {
    const r = await connected();
    r.ws().tell({ type: "lease.start", id: "l1" });
    await flush();
    r.advance(3000);
    expect(r.agent.control.phase()).toBe("active");
    r.ws().fire("close", 1006);
    expect(r.agent.control.phase()).toBe("idle");
    await r.agent.stop();
  }, 20_000);

  it("asks for the owner's approval on something critical, and acts only on the approved resend", async () => {
    const r = await connected();
    r.ws().tell({ type: "permissions", permissions: { ...NO_PC_PERMISSIONS, control: true, screen: true } });
    r.ws().tell({ type: "lease.start", id: "l1" });
    await flush();
    r.advance(3000);
    const real = r.agent as unknown as { o: { helper: { call: (op: string, a: Record<string, unknown>) => Promise<{ text: string }> } } };
    const orig = real.o.helper.call;
    real.o.helper.call = async (op, a) => (op === "element" ? { text: "Button|Delete account|Settings" } : orig(op, a));
    r.ws().tell({ type: "tool.exec", id: "c", tool: "pc.click", args: { label: 5 } });
    await flush();
    expect(r.ws().sent.find((m) => m.type === "tool.error" && m.id === "c")).toMatchObject({ needsApproval: { reason: expect.stringContaining("Delete account") } });
    r.ws().tell({ type: "tool.exec", id: "d", tool: "pc.click", args: { label: 5 }, approved: true });
    await flush();
    expect(r.ws().sent.find((m) => m.type === "tool.result" && m.id === "d")).toBeTruthy();
    await r.agent.stop();
  }, 20_000);

  it("signs out and stops when it is revoked, and passes on an update", async () => {
    const r = await connected();
    r.ws().tell({ type: "update", url: "/api/pc/agent.js", sha256: "a".repeat(64) });
    await flush();
    expect(r.events).toContain("update /api/pc/agent.js aaaa");
    r.ws().tell({ type: "revoke" });
    await flush();
    expect(r.events).toContain("revoked");
    expect(await r.agent.session.signedIn()).toBe(false);
    expect(r.agent.status.current().state).toBe("error");
    await r.agent.stop();
  }, 20_000);
});
