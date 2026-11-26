import type { ServerMsg } from "@friend/protocol";
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
import { Presenter } from "./presenter";
import { DeckStore } from "./store";

const done = { type: "done" as const };
const call = (name: string, args: unknown, id = "1") => ({ type: "tool_call" as const, id, name, args });
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function build(provider: FakeProvider) {
  const dir = mkdtempSync(join(tmpdir(), "friend-deckagent-"));
  const db = openDb(dir);
  const config = loadConfig(dir);
  const store = new DeckStore(db);
  const views: string[] = [];
  const spoken: string[] = [];
  const presenter = new Presenter({
    speak: (t) => {
      spoken.push(t);
      return new Promise<void>(() => {}); // being spoken until the owner interrupts
    },
    interrupt: () => {},
    emit: (m: ServerMsg) => void (m.type === "stage" && m.command.cmd === "deck" && views.push(m.command.view ? `${m.command.view.state}:${m.command.view.index}:${m.command.view.shown}` : "off")),
    setTimer: () => () => {},
    resumeSilenceSeconds: () => 20,
    voiceOn: () => true,
  });
  const agent = new Agent({
    provider,
    policy: new PolicyEngine(db, config),
    approvals: { request: vi.fn(async () => ({ approved: true })) } as unknown as Approvals,
    devices: { exec: vi.fn(), hasOnline: () => true, targetName: () => "pc" } as never,
    stage: new StageState(),
    db,
    audit: new Audit(db),
    config,
    assistantName: () => "Jarvis",
    decks: { store, presenter, exportDeck: async () => "x" },
  });
  return { agent, presenter, views, spoken, store };
}
const ctx = (trust: "owner" | "guest" = "owner") => ({ trust, emit: () => {}, ip: "1.1.1.1" });
const deckArgs = { title: "Hacking", slides: [{ title: "Intro", layout: "bullets", items: [{ kind: "text", content: { text: "What it is" }, say: "Hacking is finding weaknesses." }] }] };

describe("the assistant makes a deck and presents it", () => {
  it("creates it, presents it, and the screens are told slide by slide while it is spoken", async () => {
    const p = new FakeProvider([[call("deck.create", deckArgs), done], [{ type: "text_delta", text: "ok" }, done]]);
    const b = build(p);
    await b.agent.runTurn("make a presentation on hacking", ctx());
    const id = b.store.list()[0]!.id;
    expect(b.store.list()).toHaveLength(1);
    expect(JSON.stringify(p.calls[1]!.messages)).toContain("Saved.");
    expect(JSON.stringify(p.calls[1]!.messages)).toContain(id);
  });

  it("presents, and a paused presentation is told to the assistant on the owner's next request", async () => {
    const p = new FakeProvider([[call("deck.create", deckArgs), done], [{ type: "text_delta", text: "ok" }, done]]);
    const b = build(p);
    // the model learns the id from the first result: do it in two requests
    await b.agent.runTurn("make a presentation", ctx());
    const id = b.store.list()[0]!.id;
    const second = new FakeProvider([[call("deck.present", { id }), done], [{ type: "text_delta", text: "presenting" }, done]]);
    (b.agent as unknown as { deps: { provider: unknown } }).deps.provider = second;
    await b.agent.runTurn("present it", ctx());
    await flush();
    expect(b.views).toContain("playing:0:1");
    expect(b.spoken).toEqual(["Hacking is finding weaknesses."]);
    b.presenter.userSpoke();
    await flush();
    const third = new FakeProvider([[{ type: "text_delta", text: "answer" }, done]]);
    (b.agent as unknown as { deps: { provider: unknown } }).deps.provider = third;
    await b.agent.runTurn("what does that mean?", ctx());
    expect(JSON.stringify(third.calls[0])).toContain("is paused at slide 1 of 1");
  });

  it("is not for guests", async () => {
    const p = new FakeProvider([[call("deck.create", deckArgs), done], [{ type: "text_delta", text: "no" }, done]]);
    const b = build(p);
    await b.agent.runTurn("make a presentation", ctx("guest"));
    expect(b.store.list()).toHaveLength(0);
  });
});
