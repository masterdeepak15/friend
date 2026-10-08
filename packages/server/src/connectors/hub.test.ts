import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { ToolBridge } from "../provider/claude-code/bridge";
import { McpHub, friendlyToolName } from "./hub";
import { ConnectorInput, ConnectorStore } from "./store";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "testing", "fake-mcp.mjs");
const stdio = (id: string, extra: Record<string, unknown> = {}) => ({ id, name: `Fake ${id}`, kind: "stdio", command: process.execPath, args: [FAKE], ...extra });

let dir = "";
const hubs: McpHub[] = [];
const bridges: ToolBridge[] = [];
function make(opts: ConstructorParameters<typeof McpHub>[1] = {}, existing?: string) {
  dir = existing ?? mkdtempSync(join(tmpdir(), "friend-hub-"));
  const hub = new McpHub(new ConnectorStore(dir), opts);
  hubs.push(hub);
  return hub;
}
afterEach(async () => {
  for (const h of hubs.splice(0)) await h.close();
  for (const b of bridges.splice(0)) await b.stop();
});

describe("a program connector", () => {
  it("connects, lists its tools under mcp.<id>.<tool>, and tells the model about it", async () => {
    const hub = make();
    const view = await hub.add(stdio("fake"));
    expect(view).toMatchObject({ id: "fake", status: "ready", enabled: true, tools: 8, error: null });
    const names = hub.toolSpecs().map((t) => t.name);
    expect(names).toContain("mcp.fake.echo");
    expect(hub.toolSpecs().find((t) => t.name === "mcp.fake.echo")).toMatchObject({ description: "[Fake fake] Returns the text.", inputSchema: { type: "object" } });
    expect(hub.has("mcp.fake.echo")).toBe(true);
    expect(hub.summary()).toMatch(/fake \(Fake fake: ready, 8 tools\)/);
  });

  it("calls a tool and returns its text; an error result stays an error", async () => {
    const hub = make();
    await hub.add(stdio("fake"));
    expect(await hub.call("mcp.fake.echo", { text: "hi" })).toEqual({ text: "echo: hi", isError: false });
    expect(await hub.call("mcp.fake.boom", {})).toEqual({ text: "it broke", isError: true });
    expect(await hub.call("mcp.fake.nothing", {})).toMatchObject({ isError: true, text: expect.stringMatching(/Unknown connector tool/) });
  });

  it("names a picture instead of carrying it", async () => {
    const hub = make();
    await hub.add(stdio("fake"));
    const r = await hub.call("mcp.fake.picture", {});
    expect(r.text).toMatch(/picture.*image\/png.*not shown/);
    expect(r.text).not.toContain("QUJD");
  });

  it("makes awkward and long tool names usable, short and unique", async () => {
    const hub = make();
    await hub.add(stdio("fake"));
    const names = hub.toolSpecs().map((t) => t.name);
    expect(names).toContain("mcp.fake.do_thing"); // the double underscore would have been read as a dot
    for (const n of names) expect(n.split(".")[2]!.length).toBeLessThanOrEqual(28);
    expect(new Set(names).size).toBe(names.length);
    // and the real name is still the one that gets called
    expect((await hub.call("mcp.fake.do_thing", {})).text).toBe("called do__thing");
    const long = names.find((n) => n.includes("a-very-long"))!;
    expect((await hub.call(long, {})).text).toContain("called a-very-long-tool-name");
  });

  it("gives the program its secret variables and never shows them", async () => {
    const hub = make();
    const view = await hub.add(stdio("fake", { env: { FAKE_SECRET: "s3cr3t-value" } }));
    expect((await hub.call("mcp.fake.secret", {})).text).toBe("secret=s3cr3t-value");
    expect(view.secret).toBe(true);
    expect(JSON.stringify(hub.list())).not.toContain("s3cr3t-value");
    expect(JSON.stringify(hub.summary())).not.toContain("s3cr3t-value");
  });

  it("keeps the secrets in a file only this user can read, and shows no secret in the target", async () => {
    const hub = make();
    await hub.add(stdio("fake", { env: { FAKE_SECRET: "abc" } }));
    expect(readFileSync(join(dir, "connectors.json"), "utf8")).toContain("abc");
    expect(hub.list()[0]!.target).not.toContain("abc");
  });
});

describe("switching connectors", () => {
  it("off removes its tools, on brings them back, reload connects again", async () => {
    const hub = make();
    await hub.add(stdio("fake"));
    expect((await hub.setEnabled("fake", false)).status).toBe("off");
    expect(hub.toolSpecs()).toEqual([]);
    expect(hub.has("mcp.fake.echo")).toBe(false);
    expect((await hub.call("mcp.fake.echo", { text: "x" })).isError).toBe(true);
    expect((await hub.setEnabled("fake", true)).status).toBe("ready");
    expect(hub.has("mcp.fake.echo")).toBe(true);
    expect((await hub.reload("fake")).status).toBe("ready");
  });

  it("remove forgets it completely", async () => {
    const hub = make();
    await hub.add(stdio("fake"));
    await hub.remove("fake");
    expect(hub.list()).toEqual([]);
    expect(hub.has("mcp.fake.echo")).toBe(false);
    await expect(hub.remove("fake")).rejects.toThrow(/no connector/);
    await expect(hub.setEnabled("nope", true)).rejects.toThrow(/no connector/);
  });

  it("can be added switched off", async () => {
    const hub = make();
    const v = await hub.add(stdio("fake"), { enable: false });
    expect(v).toMatchObject({ enabled: false, status: "off", tools: 0 });
    expect(hub.toolSpecs()).toEqual([]);
  });

  it("comes back after a restart of Friend, connecting the ones that were on", async () => {
    const first = make();
    await first.add(stdio("on"));
    await first.add(stdio("off"), { enable: false });
    await first.close();
    const second = make({}, dir);
    expect(second.list().map((c) => [c.id, c.enabled])).toEqual([["on", true], ["off", false]]);
    second.startAll();
    for (let i = 0; i < 100 && second.list()[0]!.status !== "ready"; i++) await new Promise((r) => setTimeout(r, 100));
    expect(second.list()[0]!.status).toBe("ready");
    expect(second.list()[1]!.status).toBe("off");
  });

  it("refuses a duplicate id", async () => {
    const hub = make();
    await hub.add(stdio("fake"));
    await expect(hub.add(stdio("fake"))).rejects.toThrow(/already a connector/);
  });
});

describe("when a connector does not work", () => {
  it("shows why instead of failing: a program that is not there", async () => {
    const hub = make();
    const v = await hub.add({ id: "ghost", name: "Ghost", kind: "stdio", command: "definitely-not-a-real-program", args: [] });
    expect(v.status).toBe("error");
    expect(v.error).toBeTruthy();
    expect(hub.toolSpecs()).toEqual([]);
    expect(hub.summary()).toMatch(/ghost \(Ghost: not working/);
  });

  it("gives up on a program that never answers", async () => {
    const hub = make({ connectTimeoutMs: 600 });
    const v = await hub.add(stdio("mute", { env: { FAKE_MCP_SILENT: "1" } }));
    expect(v.status).toBe("error");
    expect(v.error).toMatch(/did not answer in time/);
  });

  it("notices when the program dies, says so, and starts it again for the next call", async () => {
    const hub = make();
    await hub.add(stdio("fake"));
    const died = await hub.call("mcp.fake.die", {});
    expect(died.isError).toBe(true);
    const again = await hub.call("mcp.fake.echo", { text: "back" });
    expect(again).toEqual({ text: "echo: back", isError: false });
  });

  it("a call that takes too long ends with an error, and a cancelled call stops", async () => {
    const hub = make({ callTimeoutMs: 400 });
    await hub.add(stdio("fake"));
    const slow = await hub.call("mcp.fake.slow", { ms: 3000 });
    expect(slow.isError).toBe(true);
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 100);
    const cancelled = await hub.call("mcp.fake.slow", { ms: 3000 }, ac.signal);
    expect(cancelled).toEqual({ text: "Cancelled.", isError: true });
  });

  it("a bad saved file is treated as empty", () => {
    dir = mkdtempSync(join(tmpdir(), "friend-hub-"));
    writeFileSync(join(dir, "connectors.json"), "{nonsense");
    expect(new ConnectorStore(dir).list()).toEqual([]);
  });
});

describe("a connector that is already running (HTTP)", () => {
  async function server() {
    const bridge = new ToolBridge((call) => call.respond({ text: `got ${JSON.stringify(call.args)}` }));
    bridge.setTools([{ name: "ping", description: "Pings.", inputSchema: { type: "object", properties: { n: { type: "number" } } } }]);
    await bridge.start();
    bridges.push(bridge);
    return bridge;
  }

  it("connects with its header, lists tools, calls them, and never shows the header", async () => {
    const b = await server();
    const hub = make();
    const v = await hub.add({ id: "web", name: "Web", kind: "http", url: b.url, headers: { Authorization: `Bearer ${b.token}` } });
    expect(v).toMatchObject({ status: "ready", tools: 1, kind: "http", secret: true });
    expect(await hub.call("mcp.web.ping", { n: 1 })).toEqual({ text: 'got {"n":1}', isError: false });
    expect(JSON.stringify(hub.list())).not.toContain(b.token);
  });

  it("is refused without the right header, with a reason", async () => {
    const b = await server();
    const hub = make();
    const v = await hub.add({ id: "web", name: "Web", kind: "http", url: b.url });
    expect(v.status).toBe("error");
  });

  it("hides what follows the ? in the address (it may be a token)", async () => {
    const hub = make();
    const v = await hub.add({ id: "web", name: "Web", kind: "http", url: "http://127.0.0.1:1/mcp?token=topsecret" });
    expect(v.target).toBe("http://127.0.0.1:1/mcp?…");
    expect(v.secret).toBe(true);
    expect(JSON.stringify(hub.list())).not.toContain("topsecret");
  });
});

describe("what may be saved", () => {
  const ok = (v: unknown) => ConnectorInput.safeParse(v).success;
  it("accepts a program and a loopback or https address", () => {
    expect(ok(stdio("a"))).toBe(true);
    expect(ok({ id: "w", name: "W", kind: "http", url: "https://mcp.example.com/mcp" })).toBe(true);
    expect(ok({ id: "w", name: "W", kind: "http", url: "http://localhost:8766/mcp" })).toBe(true);
    expect(ok({ id: "w", name: "W", kind: "http", url: "http://[::1]:8766/mcp" })).toBe(true);
  });
  it("refuses plain http to another machine, odd addresses and odd ids", () => {
    expect(ok({ id: "w", name: "W", kind: "http", url: "http://example.com/mcp" })).toBe(false);
    expect(ok({ id: "w", name: "W", kind: "http", url: "file:///etc/passwd" })).toBe(false);
    expect(ok({ id: "w", name: "W", kind: "http", url: "nonsense" })).toBe(false);
    for (const id of ["", "UPPER", "has space", "a_b", "a.b", "-x", "x-", "a".repeat(17)]) expect(ok(stdio(id)), id).toBe(false);
  });
  it("refuses extra fields, control characters, and too many arguments or variables", () => {
    expect(ok({ ...stdio("a"), extra: 1 })).toBe(false);
    expect(ok({ ...stdio("a"), command: "bad\ncommand" })).toBe(false);
    expect(ok({ ...stdio("a"), name: "bad\u0000name" })).toBe(false);
    expect(ok({ ...stdio("a"), args: Array.from({ length: 21 }, () => "x") })).toBe(false);
    expect(ok({ ...stdio("a"), env: { "bad name": "x" } })).toBe(false);
    expect(ok({ ...stdio("a"), env: Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`V${i}`, "x"])) })).toBe(false);
  });
  it("a program is started directly, never through a shell, so shell text in the command is just a missing program", async () => {
    const hub = make();
    const v = await hub.add({ id: "x", name: "X", kind: "stdio", command: "node && echo pwned", args: [] });
    expect(v.status).toBe("error");
  });
  it("limits the number of connectors", async () => {
    const hub = make();
    for (let i = 0; i < 20; i++) await hub.add({ id: `c${i}`, name: `C${i}`, kind: "stdio", command: "definitely-not-a-real-program", args: [] }, { enable: false });
    await expect(hub.add(stdio("one-more"), { enable: false })).rejects.toThrow(/At most 20/);
  });
});

describe("friendlyToolName", () => {
  it("keeps good names, fixes odd ones, shortens long ones, and never repeats", () => {
    const taken = new Set<string>();
    expect(friendlyToolName("take_snapshot", taken)).toBe("take_snapshot");
    expect(friendlyToolName("take_snapshot", taken)).toBe("take_snapshot_2");
    expect(friendlyToolName("a b/c", taken)).toBe("a-b-c");
    expect(friendlyToolName("x".repeat(60), taken).length).toBeLessThanOrEqual(28);
    expect(friendlyToolName("___", taken)).toBe("tool");
  });
});
