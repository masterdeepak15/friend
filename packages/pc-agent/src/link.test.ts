import type { PcDown } from "@friend/protocol";
import { createHash } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Link, type LinkState, type WsLike } from "./link";
import { Session, signIn } from "./signin";
import { AgentStore, type Sealer } from "./store";

class FakeWs implements WsLike {
  sent: string[] = [];
  closed = false;
  private on_: Record<string, ((...a: never[]) => void)[]> = {};
  send(d: string): void {
    this.sent.push(d);
  }
  close(): void {
    this.closed = true;
  }
  on(ev: string, cb: (...a: never[]) => void): void {
    (this.on_[ev] ??= []).push(cb);
  }
  fire(ev: string, ...args: unknown[]): void {
    for (const cb of this.on_[ev] ?? []) (cb as (...a: unknown[]) => void)(...args);
  }
}

function rig(access: () => Promise<string | null | "offline"> = async () => "tok", refresh: () => Promise<"ok" | "refused" | "offline"> = async () => "ok") {
  const sockets: FakeWs[] = [];
  const tokens: string[] = [];
  const states: LinkState[] = [];
  const got: PcDown[] = [];
  const timers: { ms: number; fn: () => void; live: boolean }[] = [];
  const link = new Link({
    getAccess: access,
    refresh,
    onMessage: (m) => got.push(m),
    onState: (s) => states.push(s),
    connect: (t) => {
      tokens.push(t);
      const w = new FakeWs();
      sockets.push(w);
      return w;
    },
    setTimer: (fn, ms) => {
      const t = { ms, fn, live: true };
      timers.push(t);
      return () => (t.live = false);
    },
    random: () => 0.5,
  });
  const flush = () => new Promise<void>((r) => setTimeout(r, 0));
  const fireTimer = async () => {
    const t = timers.find((x) => x.live)!;
    t.live = false;
    t.fn();
    await flush();
  };
  return { link, sockets, tokens, states, got, timers, flush, fireTimer };
}

describe("the connection to Friend", () => {
  it("connects with the access token, says it is online, passes messages up and sends messages out", async () => {
    const r = rig();
    r.link.start();
    await r.flush();
    r.sockets[0]!.fire("open");
    expect(r.tokens).toEqual(["tok"]);
    expect(r.states).toEqual(["connecting", "online"]);
    r.sockets[0]!.fire("message", Buffer.from(JSON.stringify({ type: "lease.start", id: "l1" })));
    r.sockets[0]!.fire("message", Buffer.from("not json"));
    r.sockets[0]!.fire("message", Buffer.from(JSON.stringify({ type: "nope" })));
    expect(r.got).toEqual([{ type: "lease.start", id: "l1" }]);
    expect(r.link.send({ type: "human.input" })).toBe(true);
    expect(r.sockets[0]!.sent).toEqual([JSON.stringify({ type: "human.input" })]);
  });

  it("does not queue what it cannot send", async () => {
    const r = rig();
    expect(r.link.send({ type: "human.input" })).toBe(false);
    r.link.start();
    await r.flush();
    expect(r.link.send({ type: "human.input" })).toBe(false); // connecting, not open
  });

  it("reconnects with a growing wait, and starts again from one second after a good connection", async () => {
    const r = rig();
    r.link.start();
    await r.flush();
    for (const expected of [1000, 2000, 4000]) {
      r.sockets.at(-1)!.fire("close", 1006);
      expect(r.timers.filter((t) => t.live).map((t) => t.ms)).toEqual([expected]);
      await r.fireTimer();
    }
    r.sockets.at(-1)!.fire("open");
    r.sockets.at(-1)!.fire("close", 1006);
    expect(r.timers.filter((t) => t.live).map((t) => t.ms)).toEqual([1000]);
    expect(r.states.at(-1)).toBe("offline");
  });

  it("caps the wait at a minute", async () => {
    const r = rig();
    r.link.start();
    await r.flush();
    for (let i = 0; i < 9; i++) {
      r.sockets.at(-1)!.fire("close", 1006);
      await r.fireTimer();
    }
    r.sockets.at(-1)!.fire("close", 1006);
    expect(Math.max(...r.timers.map((t) => t.ms))).toBe(60_000);
  });

  it("refreshes the sign-in when Friend says the token ran out, then connects again with the new one", async () => {
    let n = 0;
    const r = rig(async () => `tok${++n}`);
    r.link.start();
    await r.flush();
    r.sockets[0]!.fire("close", 4401);
    await r.flush();
    expect(r.tokens).toEqual(["tok1", "tok2"]);
  });

  it("stops for good when the PC was revoked, or when the refresh is refused", async () => {
    const a = rig();
    a.link.start();
    await a.flush();
    a.sockets[0]!.fire("close", 4403);
    await a.flush();
    expect(a.states.at(-1)).toBe("revoked");
    expect(a.timers.filter((t) => t.live)).toHaveLength(0);

    const b = rig(async () => "tok", async () => "refused");
    b.link.start();
    await b.flush();
    b.sockets[0]!.fire("close", 4401);
    await b.flush();
    expect(b.states.at(-1)).toBe("revoked");
    expect(b.sockets).toHaveLength(1);
  });

  it("when Friend cannot be reached at start (no network after a restart) it keeps trying, and is not revoked", async () => {
    let up = false;
    const r = rig(async () => (up ? "tok" : "offline"));
    r.link.start();
    await r.flush();
    expect(r.states.at(-1)).toBe("offline");
    expect(r.sockets).toHaveLength(0);
    up = true;
    await r.fireTimer();
    expect(r.sockets).toHaveLength(1);
  });

  it("stop closes the socket and stops retrying", async () => {
    const r = rig();
    r.link.start();
    await r.flush();
    r.sockets[0]!.fire("open");
    r.link.stop();
    expect(r.sockets[0]!.closed).toBe(true);
    r.sockets[0]!.fire("close", 1000);
    expect(r.timers.filter((t) => t.live)).toHaveLength(0);
  });
});

/** A tiny Friend that checks the PKCE proof the way the real one does. */
function fakeFriend() {
  let challenge = "";
  let approved = false;
  let refreshes = 0;
  const calls: string[] = [];
  const f = (async (url: string, init: RequestInit) => {
    const path = new URL(url).pathname;
    calls.push(path);
    const body = JSON.parse(String(init.body ?? "{}")) as Record<string, string>;
    const reply = (status: number, b: object) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });
    if (path === "/api/pc/enroll/start") {
      if (body.enrollmentId !== "enroll-ok") return reply(400, { error: "This install link is not valid any more." });
      challenge = body.challenge!;
      return reply(200, { deviceCode: "d".repeat(30), userCode: "ABCD-2345", verifyPath: "/pc/approve?code=ABCD-2345", interval: 1, expiresIn: 600 });
    }
    if (path === "/api/pc/enroll/token") {
      if (createHash("sha256").update(body.verifier!).digest("base64url") !== challenge) return reply(400, { error: "invalid" });
      return approved ? reply(200, { access: "A1", refresh: "R1".padEnd(30, "x"), pcId: 7, expiresIn: 3600 }) : reply(202, { pending: true });
    }
    if (path === "/api/pc/token/refresh") {
      refreshes++;
      return body.refresh?.startsWith("R") ? reply(200, { access: `A${refreshes + 1}`, refresh: `R${refreshes + 1}`.padEnd(30, "x"), pcId: 7, expiresIn: 3600 }) : reply(401, { error: "no" });
    }
    return reply(404, {});
  }) as unknown as typeof fetch;
  return { f, approve: () => (approved = true), calls };
}

describe("signing in for the first time", () => {
  it("shows the owner a code, waits for the approval, and gets the tokens by proving it is the same program", async () => {
    const friend = fakeFriend();
    let shown = "";
    let polls = 0;
    const tokens = await signIn({
      server: "https://maya.example.com/",
      enrollmentId: "enroll-ok",
      os: "Windows 11",
      host: "OFFICE-PC",
      fetch: friend.f,
      show: (url, code) => (shown = `${url} ${code}`),
      sleep: async () => {
        if (++polls === 3) friend.approve();
      },
    });
    expect(shown).toBe("https://maya.example.com/pc/approve?code=ABCD-2345 ABCD-2345");
    expect(tokens).toMatchObject({ access: "A1", pcId: 7 });
    expect(polls).toBe(3);
  });

  it("says in words when the install link is no good", async () => {
    const friend = fakeFriend();
    await expect(signIn({ server: "https://x", enrollmentId: "old", os: "w", host: "h", fetch: friend.f, show: () => {}, sleep: async () => {} })).rejects.toThrow(/not valid/);
  });

  it("gives up when nobody approves in time", async () => {
    const friend = fakeFriend();
    await expect(signIn({ server: "https://x", enrollmentId: "enroll-ok", os: "w", host: "h", fetch: friend.f, show: () => {}, sleep: async () => {}, maxWaitMs: -1 })).rejects.toThrow(/not approved in time/);
  });
});

describe("staying signed in", () => {
  const reverse: Sealer = { seal: async (p) => Buffer.from(p).toString("base64"), unseal: async (s) => Buffer.from(s, "base64").toString() };
  const store = () => new AgentStore(join(mkdtempSync(join(tmpdir(), "friend-session-")), "agent.db"));

  it("keeps the refresh token sealed, renews the access token before it runs out, and remembers the sign-in after a restart", async () => {
    const friend = fakeFriend();
    const s = store();
    let now = 1_000_000;
    const a = new Session(s, reverse, "https://x", () => now, friend.f);
    expect(await a.signedIn()).toBe(false);
    await a.save({ access: "A1", refresh: "R1".padEnd(30, "x"), pcId: 7, expiresIn: 3600 });
    expect(await a.access()).toBe("A1");
    now += 59 * 60_000;
    expect(await a.access()).toBe("A2"); // within two minutes of running out: renewed
    const b = new Session(s, reverse, "https://x", () => now, friend.f); // a restart
    expect(await b.signedIn()).toBe(true);
    expect(await b.access()).toBe("A3");
  });

  it("tells a refused sign-in from no network: only a refusal ends it", async () => {
    const s = store();
    const down = (async () => {
      throw new Error("ENETUNREACH");
    }) as unknown as typeof fetch;
    const a = new Session(s, reverse, "https://x", Date.now, down);
    await a.save({ access: "A1", refresh: "R1".padEnd(30, "x"), pcId: 7, expiresIn: 1 });
    expect(await a.access()).toBe("offline");
    expect(await a.signedIn()).toBe(true);
    const friend = fakeFriend();
    const b = new Session(s, reverse, "https://x", Date.now, ((u: string, i: RequestInit) => friend.f(u, { ...i, body: JSON.stringify({ refresh: "stolen" }) })) as unknown as typeof fetch);
    expect(await b.refresh()).toBe("refused");
    expect(await b.signedIn()).toBe(false);
  });
});
