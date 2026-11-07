import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMsg } from "@friend/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "../approvals";
import { Audit } from "../audit";
import { Auth } from "../auth";
import type { CameraBroker } from "../camera";
import { loadConfig } from "../config";
import { openDb, type Db } from "../db";
import { MemoryTree } from "../memory/tree";
import { People } from "../people";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { StageState } from "../stage";
import { Agent } from "./loop";

const call = (id: string, name: string, args: unknown = {}): ProviderEvent => ({ type: "tool_call", id, name, args });
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };
const pin = "123456";
const DIM = 128;
function face(seed: number): number[] {
  let s = seed * 9301 + 49297;
  return Array.from({ length: DIM }, () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280 - 0.5;
  });
}

let emitted: ServerMsg[];
let decision: "approve" | "deny";
let approvals: Approvals;
let db: Db;
let dir: string;
let tree: MemoryTree;
let people: People;
let shown: number[][] | undefined;
let snap: ReturnType<typeof vi.fn<CameraBroker["request"]>>;
let build: (provider: FakeProvider & { vision?: boolean }) => Agent;

const emit = (m: ServerMsg) => {
  emitted.push(m);
  if (m.type === "approval.request") void approvals.respond({ id: m.id, decision, pin: m.needsPin ? pin : undefined }, "9.9.9.9");
};
const turn = (source: string | null = "chat", trust: "owner" | "guest" | "member" = "owner") => ({ trust, emit, ip: "9.9.9.9", ...(source ? { source } : {}) });
const seeing = (script: ProviderEvent[][]) => Object.assign(new FakeProvider(script), { vision: true });
const lastTool = (p: FakeProvider) => JSON.stringify(p.calls[1]!.messages.at(-1));
const cards = () => emitted.filter((m) => m.type === "approval.request") as Extract<ServerMsg, { type: "approval.request" }>[];

beforeEach(async () => {
  emitted = [];
  decision = "approve";
  shown = [face(1)];
  snap = vi.fn<CameraBroker["request"]>(async () => ({ ok: true, mime: "image/jpeg", data: "QUJD", ...(shown ? { faces: shown } : {}) }));
  dir = mkdtempSync(join(tmpdir(), "friend-people-agent-"));
  db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin, assistantName: "Jarvis" });
  const config = loadConfig(dir);
  const policy = new PolicyEngine(db, config);
  approvals = new Approvals({ auth, policy, audit, db }, 500);
  tree = new MemoryTree(join(dir, "memory"), () => Date.UTC(2026, 10, 7, 12));
  tree.ensure();
  people = new People(db, dir);
  build = (provider) =>
    new Agent({
      provider,
      policy,
      approvals,
      devices: { exec: vi.fn(), hasOnline: () => true, targetName: () => "pc" } as never,
      stage: new StageState(),
      db,
      audit,
      config,
      assistantName: () => "Jarvis",
      camera: { request: snap },
      memoryTree: tree,
      people,
    });
});

describe("people.introduce", () => {
  it("needs the PIN, takes one look that asks for faces, and remembers the face and a note", async () => {
    const p = seeing([[call("1", "people.introduce", { name: "Priya", relation: "sister" }), done], [text("ok"), done]]);
    await build(p).runTurn("this is Priya, my sister", turn());
    expect(cards()[0]).toMatchObject({ tool: "people.introduce", tier: "T3", needsPin: true });
    expect(cards()[0]!.summary).toMatch(/remember.*face.*Priya/i);
    expect(snap).toHaveBeenCalledTimes(1);
    expect(snap.mock.calls[0]![3]).toBe(true); // the browser is asked to find faces
    expect(people.list()).toMatchObject([{ name: "Priya", relation: "sister", usable: true }]);
    expect(tree.read("people/priya.md").ok).toBe(true);
    expect(lastTool(p)).toMatch(/Priya/);
    expect(JSON.stringify(db.prepare("select content_json from messages").all())).not.toContain(String(face(1)[3]));
  });

  it("does nothing when the owner says no", async () => {
    decision = "deny";
    await build(seeing([[call("1", "people.introduce", { name: "Priya" }), done], [text("ok"), done]])).runTurn("this is Priya", turn());
    expect(snap).not.toHaveBeenCalled();
    expect(people.list()).toEqual([]);
  });

  it.each([
    ["no face in view", [], /no face/i],
    ["two faces in view", [face(1), face(2)], /2 faces/],
  ])("stores nothing with %s", async (_n, faces, message) => {
    shown = faces;
    const p = seeing([[call("1", "people.introduce", { name: "Priya" }), done], [text("ok"), done]]);
    await build(p).runTurn("this is Priya", turn());
    expect(people.list()).toEqual([]);
    expect(lastTool(p)).toMatch(message);
  });

  it("works only at the Friend screen: a request from Telegram, the Office or a schedule is refused before anything is asked", async () => {
    for (const source of ["channel", "office", "task", "voice-unverified", null]) {
      await build(seeing([[call("1", "people.introduce", { name: "Priya" }), done], [text("ok"), done]])).runTurn("this is Priya", turn(source));
    }
    expect(cards()).toHaveLength(0);
    expect(snap).not.toHaveBeenCalled();
    expect(people.list()).toEqual([]);
  });

  it("is not available to a guest or a household member", async () => {
    for (const trust of ["guest", "member"] as const) await build(seeing([[call("1", "people.introduce", { name: "Priya" }), done], [text("ok"), done]])).runTurn("x", turn("voice", trust));
    expect(snap).not.toHaveBeenCalled();
    expect(people.list()).toEqual([]);
  });
});

describe("people.list, people.remove and people.forget_all", () => {
  beforeEach(() => {
    people.introduce({ name: "Priya", relation: "sister", embedding: face(1) });
    people.introduce({ name: "Dev", relation: "friend", embedding: face(2) });
    tree.write("people/priya.md", "Priya, the owner's sister.", { title: "Priya" });
    tree.write("people/dev.md", "Dev, a friend.", { title: "Dev" });
  });

  it("lists names and relations and never face numbers", async () => {
    const p = seeing([[call("1", "people.list"), done], [text("ok"), done]]);
    await build(p).runTurn("who do you know?", turn());
    expect(cards()).toHaveLength(0);
    expect(lastTool(p)).toMatch(/Priya \(sister\)/);
    expect(lastTool(p)).toMatch(/Dev \(friend\)/);
    expect(lastTool(p)).not.toMatch(/embedding|0\.\d{4,}/);
  });

  it("removes one person with their numbers and their note, after the PIN", async () => {
    await build(seeing([[call("1", "people.remove", { name: "priya" }), done], [text("ok"), done]])).runTurn("forget Priya", turn());
    expect(cards()[0]).toMatchObject({ tool: "people.remove", tier: "T3", needsPin: true });
    expect(people.list().map((x) => x.name)).toEqual(["Dev"]);
    expect(tree.read("people/priya.md").ok).toBe(false);
    expect(tree.read("people/dev.md").ok).toBe(true);
  });

  it("says plainly when there is no such person", async () => {
    const p = seeing([[call("1", "people.remove", { name: "Nobody" }), done], [text("ok"), done]]);
    await build(p).runTurn("forget Nobody", turn());
    expect(lastTool(p)).toMatch(/do not know anyone called Nobody/i);
    expect(people.list()).toHaveLength(2);
  });

  it("forgets everyone and every note about them, after the PIN", async () => {
    await build(seeing([[call("1", "people.forget_all"), done], [text("ok"), done]])).runTurn("forget everyone", turn());
    expect(cards()[0]).toMatchObject({ tool: "people.forget_all", tier: "T3", needsPin: true });
    expect(people.list()).toEqual([]);
    expect(tree.read("people/priya.md").ok).toBe(false);
    expect(tree.read("people/dev.md").ok).toBe(false);
  });

  it("does nothing when the owner says no", async () => {
    decision = "deny";
    await build(seeing([[call("1", "people.forget_all"), done], [text("ok"), done]])).runTurn("forget everyone", turn());
    expect(people.list()).toHaveLength(2);
  });
});
