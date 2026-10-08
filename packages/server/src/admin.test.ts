import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { makeAdmin } from "./admin";
import { authorPlugin } from "./author";
import { McpHub } from "./connectors/hub";
import { ConnectorStore } from "./connectors/store";
import { openDb } from "./db";
import { Plugins } from "./plugins";

const FAKE = join(dirname(fileURLToPath(import.meta.url)), "connectors", "testing", "fake-mcp.mjs");
let hub: McpHub;
afterEach(async () => {
  await hub?.close();
});

function setup() {
  const dir = mkdtempSync(join(tmpdir(), "friend-admin-"));
  const plugins = new Plugins(openDb(dir), join(dir, "plugins"));
  hub = new McpHub(new ConnectorStore(dir));
  const audit: [string, Record<string, unknown>][] = [];
  const admin = makeAdmin({ hub, plugins, dataDir: dir, audit: (w, d) => audit.push([w, d]) });
  return { dir, plugins, admin, audit };
}
const skill = { name: "standup", description: "Write my daily stand-up", text: "Ask what I did yesterday, then write three short bullets." };
const tool = { name: "word-count", description: "Counts words in the text argument", language: "python" as const, code: "import json;print(len(json.load(open('/work/args.json'))['text'].split()))", parameters: { text: { type: "string" as const, description: "the text" } }, required: ["text"] };

describe("authoring a plugin", () => {
  it("writes, installs and switches on a skill and a tool, and leaves no draft behind", () => {
    const { dir, plugins } = setup();
    const r = authorPlugin(plugins, join(dir, "drafts"), { id: "helper", name: "Helper", description: "d", skills: [skill], tools: [tool] });
    expect(r).toMatchObject({ ok: true, id: "helper", upgraded: false, skills: 1, tools: 1 });
    const info = plugins.list().find((p) => p.id === "helper")!;
    expect(info).toMatchObject({ enabled: true, error: null, version: "1.0.0" });
    expect(plugins.skills()).toEqual([{ plugin: "helper", name: "standup", description: "Write my daily stand-up" }]);
    expect(plugins.skillText("helper", "standup")).toContain("three short bullets");
    expect(plugins.tool("plugin.helper.word-count")?.language).toBe("python");
    expect(existsSync(join(dir, "drafts")) ? readdirSync(join(dir, "drafts")) : []).toEqual([]);
  });

  it("replaces it with a higher version when the same id is created again", () => {
    const { dir, plugins } = setup();
    authorPlugin(plugins, join(dir, "drafts"), { id: "helper", name: "Helper", skills: [skill] });
    const again = authorPlugin(plugins, join(dir, "drafts"), { id: "helper", name: "Helper", skills: [{ ...skill, text: "Newer text." }] });
    expect(again).toMatchObject({ ok: true, upgraded: true });
    expect(plugins.list().find((p) => p.id === "helper")!.version).toBe("1.0.1");
    expect(plugins.skillText("helper", "standup")).toBe("Newer text.");
  });

  it("refuses bad names, paths, sizes and languages, with a reason, and installs nothing", () => {
    const { dir, plugins } = setup();
    const bad = (spec: object) => authorPlugin(plugins, join(dir, "drafts"), spec as never);
    expect(bad({ id: "Bad Id", name: "x", skills: [skill] })).toMatchObject({ ok: false });
    expect(bad({ id: "ok", name: "x", skills: [{ ...skill, name: "../evil" }] })).toMatchObject({ ok: false, error: expect.stringMatching(/not a valid name/) });
    expect(bad({ id: "ok", name: "x", skills: [{ ...skill, name: "has_underscore" }] })).toMatchObject({ ok: false });
    expect(bad({ id: "ok", name: "x", skills: [{ ...skill, text: "x".repeat(25_000) }] })).toMatchObject({ ok: false });
    expect(bad({ id: "ok", name: "x", tools: [{ ...tool, language: "ruby" }] })).toMatchObject({ ok: false });
    expect(plugins.list()).toEqual([]);
  });

  it("a plugin with neither skills nor tools is accepted and does nothing", () => {
    const { dir, plugins } = setup();
    expect(authorPlugin(plugins, join(dir, "drafts"), { id: "empty", name: "Empty" })).toMatchObject({ ok: true, skills: 0, tools: 0 });
  });
});

describe("the admin tools", () => {
  it("create, list, switch off and on, reload and remove plugins", async () => {
    const { admin, plugins, audit } = setup();
    expect(await admin.run("plugins.list", {})).toMatch(/No plugins/);
    expect(await admin.run("plugins.create", { id: "helper", name: "Helper", skills: [skill], tools: [tool] })).toMatch(/Created the plugin helper.*1 skills, 1 tools.*skill\.use.*plugin\.helper/);
    expect(await admin.run("plugins.list", {})).toMatch(/helper: Helper 1\.0\.0, on.*\[standup\].*\[word-count\]/);
    expect(await admin.run("plugins.disable", { id: "helper" })).toMatch(/off/);
    expect(plugins.skills()).toEqual([]);
    expect(await admin.run("plugins.enable", { id: "helper" })).toMatch(/on/);
    expect(plugins.skills()).toHaveLength(1);
    expect(await admin.run("plugins.reload", {})).toMatch(/Read 1 plugins again\.$/);
    expect(await admin.run("plugins.remove", { id: "helper" })).toMatch(/Deleted/);
    expect(plugins.list()).toEqual([]);
    expect(audit.map((a) => a[0])).toEqual(["plugins.create", "plugins.disable", "plugins.enable", "plugins.reload", "plugins.remove"]);
    expect(JSON.stringify(audit)).not.toContain("three short bullets"); // what was written stays out of the audit log
  });

  it("explain a refused plugin so the AI can fix it", async () => {
    const { admin } = setup();
    await expect(admin.run("plugins.create", { id: "x", name: "x", skills: [{ ...skill, name: "Bad Name" }] })).rejects.toThrow(/was not created.*valid name/);
    await expect(admin.run("plugins.enable", { id: "nope" })).rejects.toThrow(/no plugin/);
    await expect(admin.run("plugins.remove", { id: "../x" })).rejects.toThrow(/no plugin/);
  });

  it("add, list, switch, reload and remove connectors", async () => {
    const { admin, audit } = setup();
    expect(await admin.run("connectors.list", {})).toMatch(/No connectors/);
    const added = await admin.run("connectors.add", { id: "fake", name: "Fake", kind: "stdio", command: process.execPath, args: [FAKE] });
    expect(added).toMatch(/Fake \(fake\) is on with 8 tools.*mcp\.fake\./);
    expect(await admin.run("connectors.list", {})).toMatch(/fake: Fake, stdio, ready, 8 tools/);
    expect(await admin.run("connectors.disable", { id: "fake" })).toMatch(/is off/);
    expect(hub.toolSpecs()).toEqual([]);
    expect(await admin.run("connectors.enable", { id: "fake" })).toMatch(/is on with 8 tools/);
    expect(await admin.run("connectors.reload", { id: "fake" })).toMatch(/is on with 8 tools/);
    expect(await admin.run("connectors.remove", { id: "fake" })).toMatch(/Removed/);
    expect(audit.map((a) => a[0])).toEqual(["connectors.add", "connectors.disable", "connectors.enable", "connectors.reload", "connectors.remove"]);
  });

  it("report a connector that does not start instead of pretending", async () => {
    const { admin } = setup();
    expect(await admin.run("connectors.add", { id: "ghost", name: "Ghost", kind: "stdio", command: "definitely-not-a-real-program" })).toMatch(/saved but not working/);
  });

  it("cannot give a connector a secret: the AI's add carries no variables or headers", async () => {
    const { admin, dir } = setup();
    await admin.run("connectors.add", { id: "fake", name: "Fake", kind: "stdio", command: process.execPath, args: [FAKE], env: { FAKE_SECRET: "x" } });
    expect(readFileSync(join(dir, "connectors.json"), "utf8")).not.toContain("FAKE_SECRET");
  });

  it("refuse unsafe or wrong input with a plain reason", async () => {
    const { admin } = setup();
    await expect(admin.run("connectors.add", { id: "web", name: "Web", kind: "http", url: "http://example.com/mcp" })).rejects.toThrow(/https/);
    await expect(admin.run("connectors.add", { id: "Bad Id", name: "x", kind: "stdio", command: "x" })).rejects.toThrow(/id/);
    await expect(admin.run("connectors.enable", { id: "nope" })).rejects.toThrow(/no connector/);
    await expect(admin.run("nothing.here", {})).rejects.toThrow(/Unknown tool/);
  });
});
