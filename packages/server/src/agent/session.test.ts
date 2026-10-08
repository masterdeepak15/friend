import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerMsg } from "@friend/protocol";
import { describe, expect, it, vi } from "vitest";
import { Approvals } from "../approvals";
import { Audit } from "../audit";
import { Auth } from "../auth";
import { loadConfig } from "../config";
import { openDb } from "../db";
import { PolicyEngine } from "../policy/engine";
import { FakeProvider } from "../provider/fake";
import { StageState } from "../stage";
import { Agent } from "./loop";

async function agentWith(provider: FakeProvider) {
  const dir = mkdtempSync(join(tmpdir(), "friend-session-"));
  const db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
  const config = loadConfig(dir);
  const policy = new PolicyEngine(db, config);
  return new Agent({
    provider,
    policy,
    approvals: new Approvals({ auth, policy, audit, db }, 100),
    devices: { exec: vi.fn(), hasOnline: () => true, targetName: () => "pc" } as never,
    stage: new StageState(),
    db,
    audit,
    config,
    assistantName: () => "Jarvis",
  });
}
const ctx = (trust: "owner" | "guest", emit: (m: ServerMsg) => void = () => {}) => ({ trust, emit, ip: "1.1.1.1" });
const done = { type: "done" as const };

describe("which conversation a request belongs to", () => {
  it("marks an owner's request as the owner's, so a provider with a session of its own keeps them apart", async () => {
    const p = new FakeProvider([[done]]);
    await (await agentWith(p)).runTurn("hi", ctx("owner"));
    expect(p.calls[0]!.session).toBe("owner");
  });

  it("marks an unrecognized voice's request as a guest's", async () => {
    const p = new FakeProvider([[done]]);
    await (await agentWith(p)).runTurn("hi", ctx("guest"));
    expect(p.calls[0]!.session).toBe("guest");
  });

  it("keeps every step of one request in the same conversation", async () => {
    const p = new FakeProvider([[{ type: "tool_call", id: "1", name: "stage.clear", args: {} }, done], [done]]);
    await (await agentWith(p)).runTurn("clear", ctx("owner"));
    expect(p.calls.map((c) => c.session)).toEqual(["owner", "owner"]);
  });
});

describe("telling the owner what Friend is doing", () => {
  it("says it is thinking, names the tool it runs, and clears when the request ends", async () => {
    const p = new FakeProvider([[{ type: "tool_call", id: "1", name: "stage.clear", args: {} }, done], [{ type: "text_delta", text: "Done." }, done]]);
    const seen: (string | null)[] = [];
    await (await agentWith(p)).runTurn("clear", ctx("owner", (m) => m.type === "activity" && seen.push(m.text)));
    expect(seen[0]).toBe("Thinking");
    expect(seen).toContain("Clearing the screen");
    expect(seen).toContain("Answering");
    expect(seen.at(-1)).toBeNull();
  });
});
