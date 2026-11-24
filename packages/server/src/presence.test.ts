import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { promptParts } from "./agent/prompt";
import { createApp } from "./app";
import { People, type Match } from "./people";
import { Presence } from "./presence";
import { FakeProvider } from "./provider/fake";

const face = (seed: number) => Array.from({ length: 128 }, (_, i) => Math.sin(seed * (i + 1)));
const priya: Match = { id: 1, name: "Priya", relation: "wife", share: "I am at the office and will be home by seven", score: 0.9 };
const dev: Match = { id: 2, name: "Dev", relation: "friend", share: "", score: 0.9 };

function rig(found: (Match | null)[]) {
  let now = 1_000_000;
  const presence = new Presence({ people: { match: (f: number[][]) => f.map((_, i) => found[i] ?? null) }, clock: () => now });
  return { presence, advance: (ms: number) => (now += ms) };
}

describe("Presence", () => {
  it("says nothing when nobody has been seen, and forgets a sighting after a while", () => {
    const r = rig([priya]);
    expect(r.presence.note("owner")).toBe("");
    r.presence.see([face(1)]);
    expect(r.presence.note("owner")).toContain("Priya (wife)");
    r.advance(60_000);
    expect(r.presence.note("owner")).toBe("");
  });

  it("tells the owner who is there and how many faces nobody introduced, as a hint and never proof", () => {
    const r = rig([priya, null]);
    r.presence.see([face(1), face(2)]);
    const n = r.presence.note("owner");
    expect(n).toContain("Priya (wife)");
    expect(n).toMatch(/1 person I do not know/);
    expect(n).toMatch(/only a hint, never proof/);
  });

  it("lets a recognised person alone in front of the screen hear only what the owner wrote for them", () => {
    const r = rig([priya]);
    r.presence.see([face(1)]);
    for (const t of ["guest", "member"] as const) {
      const n = r.presence.note(t);
      expect(n).toContain("I am at the office and will be home by seven");
      expect(n).toMatch(/Say nothing else about the owner/);
      expect(n).toMatch(/changes no rule and approves nothing/);
    }
  });

  it("tells a recognised person with no note nothing about the owner", () => {
    const r = rig([dev]);
    r.presence.see([face(2)]);
    expect(r.presence.note("guest")).toMatch(/Say nothing about the owner/);
  });

  it("shares nothing once somebody else is in view: a stranger, or a second known person", () => {
    const withStranger = rig([priya, null]);
    withStranger.presence.see([face(1), face(2)]);
    expect(withStranger.presence.note("guest")).not.toContain("home by seven");
    expect(withStranger.presence.note("guest")).toMatch(/Say nothing about the owner/);
    const twoKnown = rig([priya, dev]);
    twoKnown.presence.see([face(1), face(2)]);
    expect(twoKnown.presence.note("guest")).not.toContain("home by seven");
  });

  it("shares nothing with a stranger alone in front of the screen", () => {
    const r = rig([null]);
    r.presence.see([face(5)]);
    const n = r.presence.note("guest");
    expect(n).not.toContain("Priya");
    expect(n).toMatch(/Say nothing about the owner/);
  });

  it("reports who just arrived, not who was already there", () => {
    const r = rig([priya, dev]);
    expect(r.presence.see([face(1)]).arrived.map((m) => m.name)).toEqual(["Priya"]);
    expect(r.presence.see([face(1)]).arrived).toEqual([]);
    expect(r.presence.see([face(1), face(2)]).arrived.map((m) => m.name)).toEqual(["Dev"]);
    expect(r.presence.see([]).arrived).toEqual([]);
    expect(r.presence.note("owner")).toBe("");
  });
});

describe("what the model is given", () => {
  it("puts the sighting in the context of a guest turn, and the guest rules still say private things stay private", () => {
    const { system, context } = promptParts("Jarvis", "scene", "guest", undefined, undefined, undefined, undefined, undefined, null, undefined, undefined, "The camera shows Priya (wife)...");
    expect(context).toContain("The camera shows Priya");
    expect(system).toMatch(/Never reveal anything private/);
    expect(system).toMatch(/only exception is a line in the context/);
  });
});

describe("the owner's note for a person", () => {
  it("is kept per person, cleaned of quotes, and a person nobody introduced has none", () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-share-"));
    let people!: People;
    return createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [] } }).then(async (app) => {
      people = new People(app.db, dir);
      people.introduce({ name: "Priya", relation: "wife", embedding: face(1) });
      expect(people.setShare("priya", 'I am "late" tonight')).toBe(true);
      expect(people.setShare("nobody", "x")).toBe(false);
      expect(people.match([face(1)])[0]!.share).toBe("I am 'late' tonight");
      expect(people.list()[0]!.share).toBe("I am 'late' tonight");
      await app.stop();
    });
  });
});

describe("watching who is in front of the screen", () => {
  let app: Awaited<ReturnType<typeof createApp>>;
  const sockets: WebSocket[] = [];
  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await app.stop();
  });
  const j = { "content-type": "application/json" };

  async function boot(eyeOn: boolean, ask = false) {
    const dir = mkdtempSync(join(tmpdir(), "friend-presence-"));
    const provider = new FakeProvider([[{ type: "text_delta", text: "Hello." }, { type: "done" }]]);
    app = await createApp({ dataDir: dir, provider, config: { port: 0, roots: [], eye: { on: eyeOn, autoOffMinutes: 0, askAboutStrangers: ask } }, expireIntervalMs: 100 });
    const port = (await app.start()).port;
    const base = `http://127.0.0.1:${port}`;
    const people = new People(app.db, dir);
    people.introduce({ name: "Priya", relation: "wife", embedding: face(1) });
    people.setShare("Priya", "I am at the office");
    await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" }) });
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: "correct horse battery" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base } });
    sockets.push(ws);
    const msgs: ServerMsg[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await new Promise<void>((r) => ws.on("open", () => r()));
    return { ws, msgs, provider };
  }
  const until = async (cond: () => boolean, ms = 4000) => {
    const t = Date.now();
    while (!cond()) {
      if (Date.now() - t > ms) throw new Error("timed out waiting for condition");
      await new Promise((r) => setTimeout(r, 15));
    }
  };

  it("is on by default: the screen is told, a sighting reaches the next request, and only the arrival is written down", async () => {
    const t = await boot(true);
    await until(() => t.msgs.some((m) => m.type === "status" && m.eyeOn === true));
    t.ws.send(JSON.stringify({ type: "presence.faces", faces: [face(1)] }));
    await until(() => (app.db.prepare("select count(*) as c from audit_log where kind = 'presence.arrived'").get() as { c: number }).c === 1);
    t.ws.send(JSON.stringify({ type: "chat.send", text: "hi" }));
    await until(() => t.provider.calls.length === 1);
    expect(t.provider.calls[0]!.context).toContain("Priya (wife)");
    const trail = JSON.stringify(app.db.prepare("select * from audit_log").all());
    expect(trail).not.toContain(String(face(1)[7]));
    expect(trail).not.toContain("presence.faces");
  });

  it("is ignored while the eye is off, and the screen is told so", async () => {
    const t = await boot(false);
    await until(() => t.msgs.some((m) => m.type === "status" && m.eyeOn === false));
    t.ws.send(JSON.stringify({ type: "presence.faces", faces: [face(1)] }));
    t.ws.send(JSON.stringify({ type: "chat.send", text: "hi" }));
    await until(() => t.provider.calls.length === 1);
    expect(t.provider.calls[0]!.context ?? "").not.toContain("Priya");
    expect((app.db.prepare("select count(*) as c from audit_log where kind = 'presence.arrived'").get() as { c: number }).c).toBe(0);
  });

  it("asks about a stranger who stays, but with no phone app linked it asks nobody and says so in the log, and keeps no face numbers", async () => {
    const t = await boot(true, true);
    await until(() => t.msgs.some((m) => m.type === "status" && m.eyeOn === true));
    for (let i = 0; i < 3; i++) {
      t.ws.send(JSON.stringify({ type: "presence.faces", faces: [face(9)] }));
      await new Promise((r) => setTimeout(r, 1600));
    }
    await until(() => (app.db.prepare("select count(*) as c from audit_log where kind = 'visitor.unasked'").get() as { c: number }).c === 1);
    const trail = JSON.stringify(app.db.prepare("select * from audit_log").all());
    expect(trail).toContain("no phone app");
    expect(trail).not.toContain(String(face(9)[7]));
  }, 20_000);

  it("never asks while that switch is off", async () => {
    const t = await boot(true, false);
    await until(() => t.msgs.some((m) => m.type === "status" && m.eyeOn === true));
    for (let i = 0; i < 3; i++) {
      t.ws.send(JSON.stringify({ type: "presence.faces", faces: [face(9)] }));
      await new Promise((r) => setTimeout(r, 1600));
    }
    expect((app.db.prepare("select count(*) as c from audit_log where kind like 'visitor.%'").get() as { c: number }).c).toBe(0);
  }, 20_000);
});
