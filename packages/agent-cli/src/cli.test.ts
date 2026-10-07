import { Auth, Audit, loadConfig, openDb } from "@friend/server";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { run, type IO } from "./cli";
import { startFriend, type RunningFriend } from "./commands/start";
import { startDeviceNode } from "./node";

let dataDir: string;
let workspace: string;
let lines: string[];
const running: RunningFriend[] = [];

const makeIo = (answers: string[] = []): IO => ({
  dataDir,
  out: (s) => lines.push(s),
  err: (s) => lines.push(s),
  ask: async () => answers.shift() ?? "",
});

const until = async (cond: () => boolean, ms = 6000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 25));
  }
};

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "friend-cli-"));
  workspace = mkdtempSync(join(tmpdir(), "friend-ws-"));
  lines = [];
});
afterEach(async () => {
  for (const r of running.splice(0)) await r.stop();
});

const hasOwner = () => {
  const db = openDb(dataDir);
  const ok = new Auth(db, new Audit(db)).hasOwner();
  db.close();
  return ok;
};

describe("friend setup", () => {
  it("creates the owner and writes the workspace and API key to config", async () => {
    const code = await run(["setup"], makeIo(["correct horse battery", "123456", "Jarvis", workspace, "sk-test-123"]));
    expect(code).toBe(0);
    expect(hasOwner()).toBe(true);
    const cfg = loadConfig(dataDir);
    expect(cfg.roots).toEqual([workspace]);
    expect(cfg.apiKey).toBe("sk-test-123");
  });
  it("refuses to overwrite an existing owner", async () => {
    await run(["setup"], makeIo(["correct horse battery", "123456", "Jarvis", workspace, ""]));
    lines = [];
    const code = await run(["setup"], makeIo(["another password!", "654321", "Other", workspace, ""]));
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/already/i);
  });
  it("rejects a short PIN with a clear message", async () => {
    const code = await run(["setup"], makeIo(["correct horse battery", "123", "Jarvis", workspace, ""]));
    expect(code).toBe(1);
    expect(lines.join("\n")).toMatch(/PIN/);
    expect(hasOwner()).toBe(false);
  });
});

describe("friend config and status", () => {
  it("stores values with the right types and never prints the API key", async () => {
    expect(await run(["config", "set", "apiKey", "sk-secret-999"], makeIo())).toBe(0);
    expect(await run(["config", "set", "port", "9100"], makeIo())).toBe(0);
    expect(await run(["config", "set", "roots", `${workspace},${tmpdir()}`], makeIo())).toBe(0);
    const cfg = JSON.parse(readFileSync(join(dataDir, "config.json"), "utf8"));
    expect(cfg.port).toBe(9100);
    expect(cfg.roots).toHaveLength(2);
    lines = [];
    expect(await run(["status"], makeIo())).toBe(0);
    const out = lines.join("\n");
    expect(out).not.toContain("sk-secret-999");
    expect(out).toMatch(/api key:\s+set/i);
  });
  it("rejects unknown config keys", async () => {
    expect(await run(["config", "set", "nonsense", "1"], makeIo())).toBe(1);
  });
  it("prints usage and exits 1 for an unknown command", async () => {
    expect(await run(["frobnicate"], makeIo())).toBe(1);
    expect(lines.join("\n")).toMatch(/usage/i);
  });
});

describe("friend rules and devices", () => {
  const prepare = async () => {
    await run(["setup"], makeIo(["correct horse battery", "123456", "Jarvis", workspace, ""]));
    const { PolicyEngine } = await import("@friend/server");
    const db = openDb(dataDir);
    const policy = new PolicyEngine(db, loadConfig(dataDir));
    const ruleId = policy.addRule("shell.run", { command: "git status" });
    const auth = new Auth(db, new Audit(db));
    const token = auth.redeemPairCode(auth.createPairCode(), "old-laptop");
    const deviceId = auth.listDevices()[0]!.id;
    db.close();
    return { ruleId, deviceId, token };
  };

  it("lists and removes always-allow rules", async () => {
    const { ruleId } = await prepare();
    expect(await run(["rules", "list"], makeIo())).toBe(0);
    expect(lines.join(" | ")).toContain("git status");
    expect(await run(["rules", "remove", String(ruleId)], makeIo())).toBe(0);
    lines = [];
    await run(["rules", "list"], makeIo());
    expect(lines.join(" | ")).not.toContain("git status");
  });
  it("lists and revokes paired devices", async () => {
    const { deviceId, token } = await prepare();
    await run(["devices", "list"], makeIo());
    expect(lines.join(" | ")).toContain("old-laptop");
    expect(await run(["devices", "revoke", String(deviceId)], makeIo())).toBe(0);
    const db = openDb(dataDir);
    expect(new Auth(db, new Audit(db)).resolveDevice(token)).toBeNull();
    db.close();
  });
  it("rejects a missing or non-numeric id", async () => {
    await prepare();
    expect(await run(["rules", "remove", "abc"], makeIo())).toBe(1);
    expect(await run(["devices", "revoke"], makeIo())).toBe(1);
  });
});

describe("friend start and pair", () => {
  const boot = async () => {
    await run(["setup"], makeIo(["correct horse battery", "123456", "Jarvis", workspace, ""]));
    const f = await startFriend({ dataDir, port: 0, out: (s) => lines.push(s) });
    running.push(f);
    return f;
  };

  it("starts the gateway and connects a local device node", async () => {
    const f = await boot();
    await until(() => f.app.devices.hasOnline());
    const r = await f.app.devices.exec("system.info", {}, 5000);
    expect(r.ok).toBe(true);
  });
  it("reuses the same local device across restarts", async () => {
    const first = await boot();
    await until(() => first.app.devices.hasOnline());
    await first.stop();
    running.length = 0;
    const second = await startFriend({ dataDir, port: 0, out: () => {} });
    running.push(second);
    await until(() => second.app.devices.hasOnline());
    const n = (second.app.db.prepare("select count(*) c from devices").get() as { c: number }).c;
    expect(n).toBe(1);
  });
  it("prints a pairing code that another node can redeem", async () => {
    const f = await boot();
    lines = [];
    expect(await run(["pair"], makeIo())).toBe(0);
    const code = lines.join("\n").match(/\b[0-9A-F]{10}\b/)?.[0];
    expect(code).toBeTruthy();
    const res = await fetch(`http://127.0.0.1:${f.port}/api/pair`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ code, name: "second-pc" }),
    });
    const { token } = (await res.json()) as { token: string };
    const node = startDeviceNode({ url: `ws://127.0.0.1:${f.port}/device`, token, roots: [workspace], backoffMs: 100 });
    await node.connected;
    node.stop();
  });
});
