import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMsg } from "@friend/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Approvals } from "../approvals";
import { Audit } from "../audit";
import { Auth } from "../auth";
import { loadConfig } from "../config";
import { openDb } from "../db";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import type { ProviderEvent } from "../provider/types";
import { StageState } from "../stage";
import { Agent } from "./loop";

const call = (id: string, name: string, args: unknown = {}): ProviderEvent => ({ type: "tool_call", id, name, args });
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };

let emitted: ServerMsg[];
let start: ReturnType<typeof vi.fn<(t: string) => Promise<{ ok: boolean; message: string }>>>;
let build: (p: FakeProvider) => Agent;

const turn = (source: string | null = "chat", trust: "owner" | "guest" | "member" = "owner") => ({ trust, emit: (m: ServerMsg) => void emitted.push(m), ip: "9.9.9.9", ...(source ? { source } : {}) });
const lastTool = (p: FakeProvider) => JSON.stringify(p.calls[1]!.messages.at(-1));

beforeEach(async () => {
  emitted = [];
  start = vi.fn(async () => ({ ok: true, message: "I sent a link to your phone. Open it to connect Google (Gmail); it works once, for ten minutes." }));
  const dir = mkdtempSync(join(tmpdir(), "friend-connect-agent-"));
  const db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
  const config = loadConfig(dir);
  const policy = new PolicyEngine(db, config);
  const approvals = new Approvals({ auth, policy, audit, db }, 500);
  build = (provider) => new Agent({ provider, policy, approvals, devices: { exec: vi.fn(), hasOnline: () => true, targetName: () => "pc" } as never, stage: new StageState(), db, audit, config, assistantName: () => "Jarvis", oauth: { start } });
});

describe("connect.start", () => {
  it("asks for the link to go to the owner's phone and says nothing the model could use to approve it", async () => {
    const p = new FakeProvider([[call("1", "connect.start", { service: "google" }), done], [text("ok"), done]]);
    await build(p).runTurn("connect my gmail", turn());
    expect(start).toHaveBeenCalledWith("google");
    expect(lastTool(p)).toMatch(/sent a link to your phone/);
    expect(lastTool(p)).not.toMatch(/https?:\/\//);
    expect(emitted.filter((m) => m.type === "approval.request")).toHaveLength(0);
  });

  it.each([
    ["guest", "voice", "guest"],
    ["member", "voice", "member"],
  ] as const)("is refused for a %s", async (_n, source, trust) => {
    const p = new FakeProvider([[call("1", "connect.start", { service: "google" }), done], [text("ok"), done]]);
    await build(p).runTurn("connect gmail", turn(source, trust));
    expect(start).not.toHaveBeenCalled();
  });

  it.each(["office", "task", "voice-unverified", null])("is refused when the turn came from %s", async (source) => {
    const p = new FakeProvider([[call("1", "connect.start", { service: "google" }), done], [text("ok"), done]]);
    await build(p).runTurn("connect gmail", turn(source as string | null));
    expect(start).not.toHaveBeenCalled();
  });

  it("passes on what it could not do", async () => {
    start.mockResolvedValueOnce({ ok: false, message: "I do not know that one. These can sign in with a link: google." });
    const p = new FakeProvider([[call("1", "connect.start", { service: "yahoo" }), done], [text("ok"), done]]);
    await build(p).runTurn("connect yahoo", turn());
    expect(lastTool(p)).toMatch(/do not know that one/);
  });
});
