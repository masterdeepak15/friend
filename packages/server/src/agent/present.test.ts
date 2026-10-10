import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "../approvals";
import { Audit } from "../audit";
import { Auth } from "../auth";
import type { CameraBroker } from "../camera";
import { loadConfig, type Config } from "../config";
import { openDb } from "../db";
import { MediaStore } from "../media";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { StageState } from "../stage";
import { Agent } from "./loop";

const PICTURE = "QUJDREVGRw==";
const call = (id: string, name: string, args: unknown = {}): ProviderEvent => ({ type: "tool_call", id, name, args });
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };
const pin = "123456";

let emitted: ServerMsg[];
let decision: "approve" | "deny";
let approvals: Approvals;
let config: Config;
let stage: StageState;
let dir: string;
let shot: ReturnType<typeof vi.fn<CameraBroker["request"]>>;
let build: (provider: FakeProvider & { vision?: boolean }) => Agent;

const emit = (m: ServerMsg) => {
  emitted.push(m);
  if (m.type === "approval.request") void approvals.respond({ id: m.id, decision, pin: m.needsPin ? pin : undefined }, "9.9.9.9");
};
const ctx = { trust: "owner" as const, emit, ip: "9.9.9.9" };
const seeing = (script: ProviderEvent[][]) => Object.assign(new FakeProvider(script), { vision: true });
const lastTool = (p: FakeProvider) => JSON.stringify(p.calls.at(-1)!.messages.at(-1));

beforeEach(async () => {
  emitted = [];
  decision = "approve";
  shot = vi.fn<CameraBroker["request"]>(async () => ({ ok: true, mime: "image/jpeg", data: PICTURE }));
  dir = mkdtempSync(join(tmpdir(), "friend-present-"));
  const db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin, assistantName: "Jarvis" });
  config = loadConfig(dir);
  const policy = new PolicyEngine(db, config);
  approvals = new Approvals({ auth, policy, audit, db }, 500);
  stage = new StageState();
  build = (provider) =>
    new Agent({
      provider,
      policy,
      approvals,
      devices: { exec: vi.fn(), hasOnline: () => true, targetName: () => "pc" } as never,
      stage,
      db,
      audit,
      config,
      assistantName: () => "Jarvis",
      screen: { request: shot },
      media: new MediaStore(db, dir),
    });
});

describe("file.present", () => {
  it("asks for the PIN with the path, then shows the file as the right object", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "friend-doc-")), "notes.md");
    writeFileSync(file, "# Plan\n\n- one\n- two\n");
    const provider = new FakeProvider([[call("f1", "file.present", { path: file, id: "doc" }), done], [text("Here it is."), done]]);
    await build(provider).runTurn("show me my notes", ctx);
    const approval = emitted.find((m) => m.type === "approval.request") as Extract<ServerMsg, { type: "approval.request" }>;
    expect(approval).toMatchObject({ tool: "file.present", tier: "T3", needsPin: true });
    expect(approval.summary).toContain(file);
    const shown = stage.snapshot().objects.find((o) => o.id === "doc")!;
    expect(shown.type).toBe("markdown");
    expect(shown.props.text).toContain("# Plan");
    expect(lastTool(provider)).toMatch(/Showing notes\.md/);
  });

  it("shows a picture through a media address, never the path", async () => {
    const file = join(mkdtempSync(join(tmpdir(), "friend-img-")), "cat.png");
    writeFileSync(file, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]));
    await build(new FakeProvider([[call("f1", "file.present", { path: file }), done], [text("ok"), done]])).runTurn("show", ctx);
    const obj = stage.snapshot().objects[0]!;
    expect(obj.type).toBe("image");
    expect(obj.props.src).toMatch(/^\/api\/media\/[0-9a-f]{32}$/);
    expect(obj.props.title).toBe("cat.png"); // the name is the title; the folder path is not in the object
    expect(JSON.stringify(obj)).not.toContain(file);
  });

  it("still needs the PIN in auto approval mode", async () => {
    config.approvals = "auto";
    const file = join(mkdtempSync(join(tmpdir(), "friend-doc-")), "a.txt");
    writeFileSync(file, "hello");
    await build(new FakeProvider([[call("f1", "file.present", { path: file }), done], [text("ok"), done]])).runTurn("show", ctx);
    expect(emitted.find((m) => m.type === "approval.request")).toMatchObject({ needsPin: true });
  });

  it("shows nothing when the owner says no", async () => {
    decision = "deny";
    const file = join(mkdtempSync(join(tmpdir(), "friend-doc-")), "a.txt");
    writeFileSync(file, "hello");
    const provider = new FakeProvider([[call("f1", "file.present", { path: file }), done], [text("ok"), done]]);
    await build(provider).runTurn("show", ctx);
    expect(stage.snapshot().objects).toEqual([]);
    expect(lastTool(provider)).toMatch(/did not approve/);
  });

  it("explains a file that cannot be shown", async () => {
    const provider = new FakeProvider([[call("f1", "file.present", { path: join(dir, "friend.db") }), done], [text("ok"), done]]);
    await build(provider).runTurn("show", ctx);
    expect(lastTool(provider)).toMatch(/data folder cannot be shown/);
  });

  it("is refused for a guest", async () => {
    const provider = new FakeProvider([[call("f1", "file.present", { path: "C:\\x.png" }), done], [text("no"), done]]);
    await build(provider).runTurn("show", { ...ctx, trust: "guest" });
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
  });
});

describe("screen.look", () => {
  it("asks for the PIN, then hands the model the picture", async () => {
    const provider = seeing([[call("s1", "screen.look"), done], [text("Looks fine."), done]]);
    await build(provider).runTurn("check the screen", ctx);
    expect(emitted.find((m) => m.type === "approval.request")).toMatchObject({ tool: "screen.look", tier: "T3", needsPin: true });
    expect(shot).toHaveBeenCalledTimes(1);
    const toolMsg = provider.calls[1]!.messages.at(-1)!;
    expect(JSON.stringify(toolMsg.content)).toContain(PICTURE);
    expect(JSON.stringify(toolMsg.content)).toMatch(/Sandbox pages, video and PDFs appear empty/);
  });

  it("does not take the picture when the owner says no", async () => {
    decision = "deny";
    await build(seeing([[call("s1", "screen.look"), done], [text("ok"), done]])).runTurn("look", ctx);
    expect(shot).not.toHaveBeenCalled();
  });

  it("explains a model that cannot see, without asking", async () => {
    const provider = new FakeProvider([[call("s1", "screen.look"), done], [text("sorry"), done]]);
    await build(provider).runTurn("look", ctx);
    expect(emitted.some((m) => m.type === "approval.request")).toBe(false);
    expect(lastTool(provider)).toMatch(/cannot look at pictures/);
  });

  it("keeps the picture out of the stored history", async () => {
    await build(seeing([[call("s1", "screen.look"), done], [text("fine"), done]])).runTurn("look", ctx);
    const db = openDb(dir);
    expect(JSON.stringify(db.prepare("select content_json from messages").all())).not.toContain(PICTURE);
  });
});
