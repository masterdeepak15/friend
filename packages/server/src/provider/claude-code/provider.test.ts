import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import type { Msg, ProviderEvent, StreamRequest, ToolSpec } from "../types";
import { ClaudeCodeProvider, type ClaudeCodeOptions } from "./provider";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-claude.mjs");
const TOOLS: ToolSpec[] = [
  { name: "fs.list", description: "List a folder.", inputSchema: { type: "object", properties: { path: { type: "string" } } } },
  { name: "camera.snap", description: "Take a picture.", inputSchema: { type: "object", properties: {} } },
];
const text = (t: string): Msg => ({ role: "user", content: [{ type: "text", text: t }] });
const said = (t: string): Msg => ({ role: "assistant", content: [{ type: "text", text: t }] });
const called = (id: string, name: string, input: unknown = {}): Msg => ({ role: "assistant", content: [{ type: "tool_use", id, name, input }] });
const result = (id: string, content: string, isError = false): Msg["content"][number] => ({ type: "tool_result", toolUseId: id, content, isError });

interface LogLine { pid: number; start?: boolean; argv?: string[]; cwd?: string; env?: Record<string, string>; user?: { type: string; text?: string; source?: unknown }[]; mcpResults?: { isError: boolean; content: { type: string; text?: string }[] }[] }

let dir = "";
const live: ClaudeCodeProvider[] = [];

function setup(turns: unknown[], opts: Partial<ClaudeCodeOptions> = {}, existing?: string) {
  dir = existing ?? mkdtempSync(join(tmpdir(), "friend-cc-"));
  writeFileSync(join(dir, "script.json"), JSON.stringify({ turns }));
  const provider = new ClaudeCodeProvider({
    dataDir: dir,
    command: process.execPath,
    commandArgs: [FAKE],
    env: { FAKE_CLAUDE_SCRIPT: join(dir, "script.json"), FAKE_CLAUDE_STATE: join(dir, "state.json"), FAKE_CLAUDE_LOG: join(dir, "log.jsonl") },
    idleTimeoutMs: 5000,
    ...opts,
  });
  live.push(provider);
  return provider;
}
const readLog = (): LogLine[] => (existsSync(join(dir, "log.jsonl")) ? readFileSync(join(dir, "log.jsonl"), "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : []);
const starts = () => readLog().filter((l) => l.start);
const users = () => readLog().filter((l) => l.user);
const flagValue = (argv: string[], f: string) => argv[argv.indexOf(f) + 1];

const req = (messages: Msg[], over: Partial<StreamRequest> = {}): StreamRequest => ({ system: "SYS", messages, tools: TOOLS, signal: new AbortController().signal, ...over });
async function run(p: ClaudeCodeProvider, r: StreamRequest): Promise<ProviderEvent[]> {
  const out: ProviderEvent[] = [];
  for await (const e of p.stream(r)) out.push(e);
  return out;
}
const textOf = (events: ProviderEvent[]) => events.flatMap((e) => (e.type === "text_delta" ? [e.text] : [])).join("");
const calls = (events: ProviderEvent[]) => events.filter((e): e is Extract<ProviderEvent, { type: "tool_call" }> => e.type === "tool_call");

afterEach(async () => {
  for (const p of live.splice(0)) await p.close();
});

describe("what Friend runs, and what it cannot do", () => {
  it("starts one lean Claude Code with only the bridge: no built-in tools, no other MCP servers, no hooks or commands", async () => {
    const p = setup([[{ text: "Hello there." }]]);
    await run(p, req([text("hi")]));
    const [s] = starts();
    const a = s!.argv!;
    expect(a).toEqual(expect.arrayContaining(["-p", "--verbose", "--include-partial-messages", "--strict-mcp-config", "--disable-slash-commands"]));
    expect([flagValue(a, "--input-format"), flagValue(a, "--output-format")]).toEqual(["stream-json", "stream-json"]);
    expect(flagValue(a, "--tools")).toBe("");
    expect(flagValue(a, "--setting-sources")).toBe("local");
    expect(flagValue(a, "--model")).toBe("sonnet");
    expect(flagValue(a, "--system-prompt")).toBe("SYS");
    expect(flagValue(a, "--allowedTools")).toBe("mcp__friend__fs__list,mcp__friend__camera__snap");
    // nothing that would lift the walls
    for (const bad of ["--bare", "--dangerously-skip-permissions", "--permission-mode", "--add-dir", "--allow-dangerously-skip-permissions"]) expect(a).not.toContain(bad);
    expect(s!.env!.MCP_TOOL_TIMEOUT).toBe("900000"); // an approval card can take minutes
  });

  it("runs in its own empty folder under the Friend data folder, never in a project", async () => {
    const p = setup([[{ text: "ok" }]]);
    await run(p, req([text("hi")]));
    expect(starts()[0]!.cwd!.replaceAll("\\", "/").toLowerCase()).toBe(join(dir, "claude").replaceAll("\\", "/").toLowerCase());
  });

  it("points Claude at the bridge on this PC with a private token, in a file only this user can read", async () => {
    const p = setup([[{ text: "ok" }]]);
    await run(p, req([text("hi")]));
    const cfgPath = flagValue(starts()[0]!.argv!, "--mcp-config")!;
    const cfg = JSON.parse(readFileSync(cfgPath, "utf8")).mcpServers.friend;
    expect(cfg.type).toBe("http");
    expect(new URL(cfg.url).hostname).toBe("127.0.0.1");
    expect(cfg.headers.Authorization).toMatch(/^Bearer [0-9a-f]{32,}$/);
    expect(JSON.stringify(starts()[0]!.argv)).not.toContain(cfg.headers.Authorization.slice(7)); // the token is not on the command line
  });

  it("identifies itself as Claude Code that can see pictures", () => {
    const p = setup([]);
    expect(p.id).toBe("claude-code");
    expect(p.vision).toBe(true);
  });
});

describe("a plain answer", () => {
  it("streams the words as they come, then the usage, then done", async () => {
    const p = setup([[{ text: "It is a fine day." }]]);
    const events = await run(p, req([text("how is the weather?")]));
    expect(textOf(events)).toBe("It is a fine day.");
    expect(events.filter((e) => e.type === "text_delta").length).toBeGreaterThan(2); // word by word
    expect(events.find((e) => e.type === "usage")).toEqual({ type: "usage", input: 115, output: 7 });
    expect(events.at(-1)).toEqual({ type: "done" });
  });

  it("sends the owner's message and the changing context as the last block", async () => {
    const p = setup([[{ text: "ok" }]]);
    await run(p, req([text("hello")], { context: "Context for this request:\nCurrent time: 12:00" }));
    const sent = users()[0]!.user!;
    expect(sent.map((b) => b.text)).toEqual(["hello", "Context for this request:\nCurrent time: 12:00"]);
  });
});

describe("tools: Claude asks, Friend runs them with its usual approvals, Claude gets the answer", () => {
  it("hands each call to Friend as a normal tool call, then carries on when the answer comes back", async () => {
    const p = setup([[{ text: "Let me look. ", calls: [{ tool: "fs__list", args: { path: "C:/work" } }] }, { text: "You have two files." }]]);
    const first = await run(p, req([text("what is in my work folder?")]));
    expect(textOf(first)).toBe("Let me look. ");
    const [call] = calls(first);
    expect(call).toMatchObject({ name: "fs.list", args: { path: "C:/work" } });
    expect(call!.id).toMatch(/^cc-/);
    expect(first.at(-1)).toEqual({ type: "done" });

    const second = await run(p, req([text("what is in my work folder?"), called(call!.id, "fs.list", { path: "C:/work" }), { role: "tool", content: [result(call!.id, "a.txt\nb.txt")] }]));
    expect(textOf(second)).toBe("You have two files.");
    expect(second.at(-1)).toEqual({ type: "done" });
    expect(readLog().find((l) => l.mcpResults)!.mcpResults![0]).toMatchObject({ isError: false, content: [{ type: "text", text: "a.txt\nb.txt" }] });
  });

  it("passes on an error result as an error", async () => {
    const p = setup([[{ calls: [{ tool: "fs__list", args: {} }] }, { text: "That was refused." }]]);
    const [call] = calls(await run(p, req([text("go")])));
    await run(p, req([text("go"), called(call!.id, "fs.list"), { role: "tool", content: [result(call!.id, "Error: The owner did not approve this action (denied).", true)] }]));
    expect(readLog().find((l) => l.mcpResults)!.mcpResults![0]!.isError).toBe(true);
  });

  it("hands several calls over together and matches the answers by id, whatever their order", async () => {
    const p = setup([[{ calls: [{ tool: "fs__list", args: { path: "a" } }, { tool: "fs__list", args: { path: "b" } }] }, { text: "Done." }]]);
    const first = await run(p, req([text("both")]));
    const cs = calls(first);
    expect(cs).toHaveLength(2);
    expect(new Set(cs.map((c) => c.id)).size).toBe(2);
    expect(first.filter((e) => e.type === "done")).toHaveLength(1);
    const byPath = (path: string) => cs.find((c) => (c.args as { path: string }).path === path)!;
    const toolMsg: Msg = { role: "tool", content: [result(byPath("b").id, "B-RESULT"), result(byPath("a").id, "A-RESULT")] };
    await run(p, req([text("both"), { role: "assistant", content: cs.map((c) => ({ type: "tool_use" as const, id: c.id, name: c.name, input: c.args })) }, toolMsg]));
    const texts = readLog().find((l) => l.mcpResults)!.mcpResults!.map((r) => r.content[0]!.text);
    expect(texts).toEqual(["A-RESULT", "B-RESULT"]); // the script asked for a first, then b
  });

  it("can chain several tool steps in one request", async () => {
    const p = setup([[{ calls: [{ tool: "fs__list", args: { path: "1" } }] }, { calls: [{ tool: "fs__list", args: { path: "2" } }] }, { text: "Both done." }]]);
    const s1 = await run(p, req([text("go")]));
    const c1 = calls(s1)[0]!;
    const m1: Msg[] = [text("go"), called(c1.id, "fs.list"), { role: "tool", content: [result(c1.id, "one")] }];
    const s2 = await run(p, req(m1));
    const c2 = calls(s2)[0]!;
    expect(c2.args).toEqual({ path: "2" });
    const s3 = await run(p, req([...m1, called(c2.id, "fs.list"), { role: "tool", content: [result(c2.id, "two")] }]));
    expect(textOf(s3)).toBe("Both done.");
  });

  it("gives Claude a camera picture with the tool result", async () => {
    const p = setup([[{ calls: [{ tool: "camera__snap" }] }, { text: "I see a mug." }]]);
    const [call] = calls(await run(p, req([text("look")])));
    const tool: Msg = { role: "tool", content: [result(call!.id, "Picture taken."), { type: "image", mime: "image/jpeg", data: "QUJD" }] };
    await run(p, req([text("look"), called(call!.id, "camera.snap"), tool]));
    const content = readLog().find((l) => l.mcpResults)!.mcpResults![0]!.content;
    expect(content.map((c) => c.type)).toEqual(["text", "image"]);
  });
});

describe("what Claude is told, turn by turn", () => {
  it("sends only what is new each time, because Claude already remembers the rest", async () => {
    const p = setup([[{ text: "Hello Deepak." }], [{ text: "It is 12." }]]);
    await run(p, req([text("hello, I am Deepak")]));
    await run(p, req([text("hello, I am Deepak"), said("Hello Deepak."), text("what time is it?")]));
    const all = users().map((u) => u.user!.map((b) => b.text).join(" | "));
    expect(all).toEqual(["hello, I am Deepak", "what time is it?"]);
    expect(starts()).toHaveLength(1); // the same process answered both
  });

  it("includes the data Friend gathered itself (weather, stats) as text, so Claude knows what is already on the screen", async () => {
    const p = setup([[{ text: "It is 31 degrees." }]]);
    const messages: Msg[] = [
      text("weather in Pune"),
      called("auto-1", "weather.get", { city: "Pune" }),
      { role: "tool", content: [result("auto-1", "Pune: 31°C. Already on the screen.")] },
    ];
    await run(p, req(messages));
    const sent = users()[0]!.user!.map((b) => b.text).join("\n");
    expect(sent).toContain("weather in Pune");
    expect(sent).toContain("weather.get");
    expect(sent).toContain("Pune: 31°C. Already on the screen.");
  });

  it("sends a reminder nudge like any other new message", async () => {
    const p = setup([[{ text: "I will." }], [{ text: "Done." }]]);
    await run(p, req([text("do it")]));
    await run(p, req([text("do it"), said("I'll do it."), text("(Automatic reminder) call the tool now")]));
    expect(users()[1]!.user![0]!.text).toContain("Automatic reminder");
  });

  it("starts a fresh Claude with the earlier conversation written out when there is nothing to resume", async () => {
    const p = setup([[{ text: "Yes, Deepak." }]]);
    await run(p, req([text("my name is Deepak"), said("Nice to meet you."), text("do you remember my name?")]));
    const sent = users()[0]!.user!.map((b) => b.text).join("\n");
    expect(sent).toMatch(/earlier conversation/i);
    expect(sent).toContain("my name is Deepak");
    expect(sent).toContain("Nice to meet you.");
    expect(sent.lastIndexOf("do you remember my name?")).toBeGreaterThan(sent.indexOf("Earlier conversation"));
  });
});

describe("keeping the session healthy", () => {
  it("restarts with --resume when the instructions change, so the conversation carries on", async () => {
    const p = setup([[{ text: "One." }], [{ text: "Two." }]]);
    await run(p, req([text("a")], { system: "SYS-1" }));
    await run(p, req([text("a"), said("One."), text("b")], { system: "SYS-2" }));
    const [s1, s2] = starts();
    expect(flagValue(s1!.argv!, "--system-prompt")).toBe("SYS-1");
    expect(flagValue(s2!.argv!, "--system-prompt")).toBe("SYS-2");
    expect(flagValue(s2!.argv!, "--resume")).toBe("fake-session-1");
    expect(s1!.pid).not.toBe(s2!.pid);
    expect(users()[1]!.user![0]!.text).toBe("b"); // no seeding: it was resumed
  });

  it("restarts when the set of tools changes (a plugin was switched on)", async () => {
    const p = setup([[{ text: "One." }], [{ text: "Two." }]]);
    await run(p, req([text("a")]));
    await run(p, req([text("a"), said("One."), text("b")], { tools: [...TOOLS, { name: "plugin.x.y", description: "d", inputSchema: { type: "object" } }] }));
    expect(flagValue(starts()[1]!.argv!, "--allowedTools")).toContain("mcp__friend__plugin__x__y");
  });

  it("remembers the session across Friend restarts", async () => {
    const a = setup([[{ text: "One." }], [{ text: "Two." }]]);
    await run(a, req([text("a")]));
    await a.close();
    const b = setup([[{ text: "One." }], [{ text: "Two." }]], {}, dir);
    await run(b, req([text("a"), said("One."), text("b")]));
    expect(flagValue(starts()[1]!.argv!, "--resume")).toBe("fake-session-1");
    expect(users()[1]!.user![0]!.text).toBe("b");
  });

  it("starts over, seeded with the history, when the old session no longer exists", async () => {
    const a = setup([[{ text: "One." }], [{ text: "Fresh answer." }]]);
    await run(a, req([text("a")]));
    await a.close();
    writeFileSync(join(dir, "state.json"), JSON.stringify({ turn: 1, sessions: [], nextSession: 5 })); // Claude forgot it
    const b = setup([[{ text: "One." }], [{ text: "Fresh answer." }]], {}, dir);
    const events = await run(b, req([text("a"), said("One."), text("b")]));
    expect(textOf(events)).toBe("Fresh answer.");
    const ss = starts();
    expect(ss).toHaveLength(3); // the first run, the failed resume, the fresh start
    expect(ss[2]!.argv).not.toContain("--resume");
    expect(users().at(-1)!.user!.map((x) => x.text).join("\n")).toMatch(/earlier conversation/i);
  });

  it("notices a crash, says so, and starts again on the next message", async () => {
    const p = setup([[{ text: "Partly " }, { die: 3 }], [{ text: "Back." }]]);
    const first = await run(p, req([text("a")]));
    expect(first.at(-1)).toMatchObject({ type: "error", userFacing: true });
    expect(first.some((e) => e.type === "done")).toBe(false);
    const second = await run(p, req([text("a"), said("Partly"), text("b")]));
    expect(textOf(second)).toBe("Back.");
    expect(starts()).toHaveLength(2);
  });

  it("gives up on a Claude that stops answering, kills it, and recovers on the next message", async () => {
    const p = setup([[{ hang: true }], [{ text: "Alive." }]], { idleTimeoutMs: 300, startupTimeoutMs: 10_000 });
    const first = await run(p, req([text("a")]));
    expect(first.at(-1)).toMatchObject({ type: "error", userFacing: true, message: expect.stringMatching(/did not answer in time/i) });
    const second = await run(p, req([text("a"), text("b")]));
    expect(textOf(second)).toBe("Alive.");
  });

  it("does not run out of patience while Friend is busy (an approval card, a slow tool)", async () => {
    const p = setup([[{ calls: [{ tool: "fs__list", args: {} }] }, { text: "Finally." }]], { idleTimeoutMs: 2500 });
    const [call] = calls(await run(p, req([text("go")])));
    await new Promise((r) => setTimeout(r, 3500)); // the owner takes longer than the patience limit: it only counts while Claude is thinking
    const events = await run(p, req([text("go"), called(call!.id, "fs.list"), { role: "tool", content: [result(call!.id, "ok")] }]));
    expect(textOf(events)).toBe("Finally.");
  }, 20_000);

  it("stops the process and the bridge when Friend shuts down", async () => {
    const p = setup([[{ text: "ok" }]]);
    await run(p, req([text("a")]));
    const pid = starts()[0]!.pid;
    await p.close();
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(pid, 0)).toThrow();
  });
});

describe("interrupting a turn", () => {
  it("answers a waiting tool call with 'cancelled' when the owner starts something new, then carries on", async () => {
    const p = setup([[{ calls: [{ tool: "fs__list", args: {} }] }, { text: "Stopped." }], [{ text: "New answer." }]]);
    const [call] = calls(await run(p, req([text("first")])));
    // the owner changed their mind: the next request is not the answer to that call
    const events = await run(p, req([text("first"), called(call!.id, "fs.list"), text("never mind, new question")]));
    expect(textOf(events)).toBe("New answer.");
    const answered = readLog().find((l) => l.mcpResults)!.mcpResults![0]!;
    expect(answered.isError).toBe(true);
    expect(answered.content[0]!.text).toMatch(/cancel/i);
  });

  it("stops quietly when the turn is cancelled while Claude is still thinking, and works again afterwards", async () => {
    const p = setup([[{ sleep: 400 }, { text: "too late" }], [{ text: "Next." }]]);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 60);
    const first = await run(p, req([text("slow")], { signal: ac.signal }));
    expect(first.some((e) => e.type === "error")).toBe(false);
    expect(textOf(first)).toBe("");
    const second = await run(p, req([text("slow"), text("quick")]));
    expect(textOf(second)).toBe("Next.");
  });
});

describe("a guest never shares the owner's Claude", () => {
  it("answers a guest in a separate throwaway Claude with no tools and no memory of the owner", async () => {
    const p = setup([[{ text: "Hello owner." }], [{ text: "Sorry, only the owner." }]]);
    await run(p, req([text("my secret is 4711")]));
    const events = await run(p, req([text("what is the owner's secret?")], { session: "guest", system: "GUEST-RULES", tools: [] }));
    expect(textOf(events)).toBe("Sorry, only the owner.");
    const [ownerStart, guestStart] = starts();
    expect(guestStart!.pid).not.toBe(ownerStart!.pid);
    const g = guestStart!.argv!;
    expect(g).toContain("--no-session-persistence");
    expect(g).not.toContain("--mcp-config");
    expect(g).not.toContain("--resume");
    expect(flagValue(g, "--tools")).toBe("");
    expect(flagValue(g, "--system-prompt")).toBe("GUEST-RULES");
    // nothing from the owner reached the guest process, and nothing from the guest reached the owner's
    const ownerSaw = users().filter((u) => u.pid === ownerStart!.pid).map((u) => u.user![0]!.text);
    const guestSaw = users().filter((u) => u.pid === guestStart!.pid).map((u) => u.user!.map((b) => b.text).join(" "));
    expect(ownerSaw).toEqual(["my secret is 4711"]);
    expect(guestSaw.join(" ")).not.toContain("4711");
    expect(guestSaw.join(" ")).toContain("what is the owner's secret?");
  });

  it("starts a new throwaway Claude for every guest request, and ends it afterwards", async () => {
    const p = setup([[{ text: "One." }], [{ text: "Two." }]]);
    await run(p, req([text("hi")], { session: "guest", system: "G", tools: [] }));
    await run(p, req([text("hi again")], { session: "guest", system: "G", tools: [] }));
    const ss = starts();
    expect(ss).toHaveLength(2);
    expect(ss[0]!.pid).not.toBe(ss[1]!.pid);
    await new Promise((r) => setTimeout(r, 300));
    expect(() => process.kill(ss[0]!.pid, 0)).toThrow();
  });

  it("leaves the owner's session intact after a guest has spoken", async () => {
    const p = setup([[{ text: "A." }], [{ text: "Guest." }], [{ text: "B." }]]);
    await run(p, req([text("a")]));
    await run(p, req([text("who?")], { session: "guest", system: "G", tools: [] }));
    await run(p, req([text("a"), said("A."), text("b")]));
    const ownerPid = starts()[0]!.pid;
    expect(users().filter((u) => u.pid === ownerPid).map((u) => u.user![0]!.text)).toEqual(["a", "b"]);
  });
});

describe("failures the owner can understand", () => {
  it("says Claude Code is not installed, and how to fix it", async () => {
    const p = new ClaudeCodeProvider({ dataDir: mkdtempSync(join(tmpdir(), "friend-cc-")), command: "definitely-not-a-real-claude-command" });
    live.push(p);
    const events = await run(p, req([text("hi")]));
    expect(events).toEqual([{ type: "error", userFacing: true, message: expect.stringMatching(/not installed.*friend claude setup/is) }]);
  });

  it("says when Claude Code is not signed in", async () => {
    const p = setup([[{ error: "Not logged in · Please run /login" }]]);
    const events = await run(p, req([text("hi")]));
    expect(events.at(-1)).toMatchObject({ type: "error", userFacing: true, message: expect.stringMatching(/not signed in.*friend claude setup/is) });
  });

  it("reports any other error Claude Code gives, in its own words", async () => {
    const p = setup([[{ error: "Something odd happened" }]]);
    const events = await run(p, req([text("hi")]));
    expect(events.at(-1)).toMatchObject({ type: "error", userFacing: true, message: expect.stringContaining("Something odd happened") });
  });

  it("tells the owner when the plan limit is reached and when it resets, and stops asking until then", async () => {
    let now = new Date("2026-10-08T12:00:00Z").getTime(); // 17:30 in Calcutta
    const p = setup([[{ limit: "You've hit your weekly limit · resets 11:00pm (Asia/Calcutta)" }], [{ text: "Back again." }]], { now: () => now });
    const first = await run(p, req([text("hi")]));
    const err = first.at(-1) as Extract<ProviderEvent, { type: "error" }>;
    expect(err).toMatchObject({ type: "error", userFacing: true });
    expect(err.message).toMatch(/plan limit/i);
    expect(err.message).toMatch(/11:00/);

    const before = readLog().length;
    const again = await run(p, req([text("hi"), text("again")]));
    expect(again.at(-1)).toMatchObject({ type: "error", userFacing: true, message: expect.stringMatching(/plan limit/i) });
    expect(readLog().length).toBe(before); // not even a message was sent

    now += 6 * 3_600_000; // after the reset
    const later = await run(p, req([text("hi"), text("again")]));
    expect(textOf(later)).toBe("Back again.");
  });
});
