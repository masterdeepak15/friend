import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "../app";
import { openDb } from "../db";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { Household, HouseholdError, MARGIN, MAX_PEOPLE, cleanName, decideSpeaker } from "./household";
import { FakeVoice, type ScriptedUtterance } from "./service";

const T = { accept: 0.72, challenge: 0.58 };
const unit = (...v: number[]) => {
  const n = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
  return v.map((x) => x / n);
};

describe("deciding who is speaking", () => {
  it("keeps the owner's rules when nobody else is saved", () => {
    expect(decideSpeaker(0.9, null, T)).toEqual({ trust: "owner" });
    expect(decideSpeaker(0.65, null, T)).toEqual({ trust: "challenge" });
    expect(decideSpeaker(0.2, null, T)).toEqual({ trust: "guest" });
    expect(decideSpeaker(null, null, T)).toEqual({ trust: "guest" });
  });

  it("names a household member only when the voice is clearly closer to them than to the owner", () => {
    const wife = { id: 1, name: "Priya", score: 0.85 };
    expect(decideSpeaker(0.4, wife, T)).toEqual({ trust: "member", person: wife });
    expect(decideSpeaker(0.85 - MARGIN / 2, wife, T)).toEqual({ trust: "challenge" }); // barely closer to the owner: not a guess
    expect(decideSpeaker(0.85 - MARGIN / 2, { ...wife, score: 0.85 }, T).trust).not.toBe("member");
  });

  it("does not hand the owner's authority to a voice that two people could have", () => {
    expect(decideSpeaker(0.86, { id: 2, name: "Arjun", score: 0.84 }, T)).toEqual({ trust: "challenge" }); // too close to call: the PIN settles it
    expect(decideSpeaker(0.9, { id: 2, name: "Arjun", score: 0.6 }, T)).toEqual({ trust: "owner" });
  });

  it("treats a member's weak match as a guest, not as a member", () => {
    expect(decideSpeaker(0.2, { id: 1, name: "Priya", score: 0.6 }, T)).toEqual({ trust: "guest" });
  });

  it("works when only the household is known and the owner has no score", () => {
    expect(decideSpeaker(null, { id: 1, name: "Priya", score: 0.8 }, T)).toEqual({ trust: "member", person: { id: 1, name: "Priya", score: 0.8 } });
  });
});

describe("the household's voices", () => {
  const make = () => new Household(openDb(mkdtempSync(join(tmpdir(), "friend-house-"))), Buffer.alloc(32, 9));

  it("saves a person and recognizes their voice, and not someone else's", () => {
    const h = make();
    h.add("Priya", [unit(1, 0.1, 0), unit(1, 0, 0.1), unit(0.9, 0.1, 0.1)], "m");
    h.add("Arjun", [unit(0, 1, 0.1), unit(0.1, 1, 0), unit(0.1, 0.9, 0.1)], "m");
    expect(h.identify(unit(1, 0.05, 0.05))).toMatchObject({ name: "Priya" });
    expect(h.identify(unit(0.05, 1, 0.05))).toMatchObject({ name: "Arjun" });
    expect(h.identify(unit(1, 0.05, 0.05))!.score).toBeGreaterThan(0.95);
  });

  it("keeps only the averaged voice, encrypted", () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "friend-house-")));
    const h = new Household(db, Buffer.alloc(32, 9));
    h.add("Priya", [unit(1, 0, 0)], "m");
    const row = db.prepare("select centroid_enc e from voice_people").get() as { e: Buffer };
    expect(Buffer.from(new Float32Array(unit(1, 0, 0)).buffer).equals(row.e)).toBe(false); // not stored as plain numbers
    const other = new Household(db, Buffer.alloc(32, 1)); // a wrong key cannot read it
    expect(() => other.identify(unit(1, 0, 0))).toThrow();
  });

  it("refuses a name used already (any capitals), an empty name, a very long one, and a ninth person", () => {
    const h = make();
    h.add("Priya", [unit(1, 0, 0)], "m");
    expect(() => h.canAdd("priya")).toThrow(HouseholdError);
    expect(() => h.canAdd("   ")).toThrow(/name/i);
    expect(() => h.canAdd("x".repeat(60))).toThrow(/at most/);
    for (let i = 1; i < MAX_PEOPLE; i++) h.add(`Person ${i}`, [unit(1, i, 0)], "m");
    expect(() => h.canAdd("One more")).toThrow(/already/);
  });

  it("cleans a name to one plain line", () => {
    expect(cleanName("  Priya\n\tKumar \u0007 ")).toBe("Priya Kumar");
  });

  it("removes a person", () => {
    const h = make();
    const p = h.add("Priya", [unit(1, 0, 0)], "m");
    expect(h.remove(p.id)).toBe(true);
    expect(h.remove(p.id)).toBe(false);
    expect(h.list()).toEqual([]);
    expect(h.identify(unit(1, 0, 0))).toBeNull();
  });
});

// ---- the whole thing through the real app, with the scripted voice -------------------------------------------------

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App | undefined;
let port = 0;
let provider: FakeProvider;
const sockets: WebSocket[] = [];
const base = () => `http://127.0.0.1:${port}`;

async function boot(utterances: (string | ScriptedUtterance)[], script: ProviderEvent[][]) {
  provider = new FakeProvider(script);
  const voice = new FakeVoice({ transcripts: utterances, enrollSpeakers: ["owner", "owner", "owner", "wife"] });
  app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "friend-house-app-")), provider, voice, config: { port: 0, roots: [] }, expireIntervalMs: 100 });
  port = (await app!.start()).port;
  const j = { "content-type": "application/json" };
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

const call = (cookie: string, method: string, path: string, body?: unknown, type = "application/json") =>
  fetch(base() + path, { method, headers: { cookie, "content-type": type }, body: body === undefined ? undefined : type === "application/json" ? JSON.stringify(body) : (body as string) });

async function enrollOwner(cookie: string) {
  for (let i = 0; i < 3; i++) await call(cookie, "POST", "/api/voice/enroll/sample", "AUDIO", "audio/webm");
  expect((await call(cookie, "POST", "/api/voice/enroll/finish", { pin: owner.pin })).status).toBe(200);
}
async function enrollWife(cookie: string) {
  expect((await call(cookie, "POST", "/api/voice/people/begin", { name: "Priya" })).status).toBe(200);
  for (let i = 0; i < 3; i++) expect((await call(cookie, "POST", "/api/voice/people/sample", "AUDIO", "audio/webm")).status).toBe(200);
  const done = await call(cookie, "POST", "/api/voice/people/finish", { pin: owner.pin });
  expect(done.status).toBe(200);
  return done.json();
}

class Client {
  msgs: ServerMsg[] = [];
  static async connect(cookie: string): Promise<Client> {
    const c = new Client();
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base() } });
    sockets.push(ws);
    ws.on("message", (d) => c.msgs.push(JSON.parse(String(d))));
    await new Promise<void>((res) => {
      ws.on("open", () => res());
      ws.on("error", () => res());
    });
    return c;
  }
  of<T extends ServerMsg["type"]>(t: T) {
    return this.msgs.filter((m) => m.type === t) as Extract<ServerMsg, { type: T }>[];
  }
}
async function until(cond: () => boolean, ms = 4000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
}
const utter = (cookie: string) => call(cookie, "POST", "/api/voice/utterance", "AUDIO", "audio/webm");

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app?.stop();
  app = undefined;
});

describe("adding a family member's voice", () => {
  it("needs the owner signed in, the owner's own voice first, a name, samples and the PIN", async () => {
    const cookie = await boot([], []);
    expect((await fetch(base() + "/api/voice/people")).status).toBe(401);
    expect((await call(cookie, "POST", "/api/voice/people/begin", { name: "Priya" })).status).toBe(400); // the owner's voice comes first
    await enrollOwner(cookie);
    expect((await call(cookie, "POST", "/api/voice/people/begin", {})).status).toBe(400);
    expect((await call(cookie, "POST", "/api/voice/people/begin", { name: "Priya" })).status).toBe(200);
    expect((await call(cookie, "POST", "/api/voice/people/finish", { pin: owner.pin })).status).toBe(400); // too few recordings
    for (let i = 0; i < 3; i++) await call(cookie, "POST", "/api/voice/people/sample", "AUDIO", "audio/webm");
    expect((await call(cookie, "POST", "/api/voice/people/finish", { pin: "000000" })).status).toBe(403);
    expect(((await (await call(cookie, "GET", "/api/voice/people")).json()) as { people: unknown[] }).people).toHaveLength(0);
    expect(await (await call(cookie, "POST", "/api/voice/people/finish", { pin: owner.pin })).json()).toMatchObject({ name: "Priya" });
    const overview = (await (await call(cookie, "GET", "/api/voice/people")).json()) as { people: { name: string }[]; ownerEnrolled: boolean };
    expect(overview.people.map((p) => p.name)).toEqual(["Priya"]);
    expect(overview.ownerEnrolled).toBe(true);
  });

  it("refuses the same name twice and removes a person only with the PIN", async () => {
    const cookie = await boot([], []);
    await enrollOwner(cookie);
    await enrollWife(cookie);
    expect((await call(cookie, "POST", "/api/voice/people/begin", { name: "PRIYA" })).status).toBe(400);
    const id = ((await (await call(cookie, "GET", "/api/voice/people")).json()) as { people: { id: number }[] }).people[0]!.id;
    expect((await call(cookie, "DELETE", `/api/voice/people/${id}`, { pin: "000000" })).status).toBe(403);
    expect((await call(cookie, "DELETE", `/api/voice/people/${id}`, { pin: owner.pin })).status).toBe(200);
    expect(((await (await call(cookie, "GET", "/api/voice/people")).json()) as { people: unknown[] }).people).toHaveLength(0);
  });
});

describe("a household member speaking", () => {
  it("is named, answered by name with a short memory, given only the weather and screen tools, and the owner's data stays out of it", async () => {
    const cookie = await boot(
      [
        { text: "what is two plus two", speaker: "wife", detail: "a" },
        { text: "and times three", speaker: "wife", detail: "b" },
      ],
      [[text("Four, Priya."), done], [text("Twelve."), done]],
    );
    await enrollOwner(cookie);
    await enrollWife(cookie);
    const c = await Client.connect(cookie);
    const messagesBefore = (app!.db.prepare("select count(*) n from messages").get() as { n: number }).n;

    await utter(cookie);
    await until(() => provider.calls.length === 1);
    expect(c.of("voice.heard")[0]).toMatchObject({ text: "what is two plus two", trust: "member", speaker: "Priya" });
    const first = provider.calls[0]!;
    expect(first.system).toMatch(/Priya/);
    expect(first.system).toMatch(/not the owner/i);
    expect(first.tools.map((t) => t.name).sort()).toEqual(["stage.hide", "stage.mood", "stage.presence", "stage.scene", "stage.show", "stage.update", "weather.get"]);
    expect(first.session).toBe("guest"); // a separate conversation from the owner's
    expect(first.messages).toHaveLength(1);

    await until(() => !app!.agent.isBusy());
    await utter(cookie);
    await until(() => provider.calls.length === 2);
    // the second question carries the first exchange, in memory only
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain("what is two plus two");
    expect(JSON.stringify(provider.calls[1]!.messages)).toContain("Four, Priya.");

    await until(() => !app!.agent.isBusy());
    expect((app!.db.prepare("select count(*) n from messages").get() as { n: number }).n).toBe(messagesBefore); // nothing of hers is stored
    expect(c.of("chat.user")).toEqual([]); // and it is not shown in the owner's conversation
    const logged = JSON.stringify(app!.db.prepare("select * from audit_log").all());
    expect(logged).not.toContain("two plus two"); // the audit trail has no family talk
  });

  it("can not use the owner's tools even if the model asks for them", async () => {
    const cookie = await boot(
      [{ text: "list the owner's files", speaker: "wife", detail: "c" }],
      [[{ type: "tool_call", id: "t1", name: "fs.list", args: { path: "C:/" } }, done], [text("I can only do that for the owner."), done]],
    );
    await enrollOwner(cookie);
    await enrollWife(cookie);
    const c = await Client.connect(cookie);
    await utter(cookie);
    await until(() => provider.calls.length === 2);
    const result = JSON.stringify(provider.calls[1]!.messages);
    expect(result).toMatch(/not allowed/);
    expect(c.of("approval.request" as never)).toEqual([]); // and the owner is not asked to approve anything for her
  });

  it("an owner's own voice still runs as the owner with all the tools", async () => {
    const cookie = await boot([{ text: "list my files", speaker: "owner", detail: "z" }], [[text("Done."), done]]);
    await enrollOwner(cookie);
    await enrollWife(cookie);
    const c = await Client.connect(cookie);
    await utter(cookie);
    await until(() => provider.calls.length === 1);
    expect(c.of("voice.heard")[0]).toMatchObject({ trust: "owner" });
    expect(provider.calls[0]!.tools.length).toBeGreaterThan(10);
  });
});
