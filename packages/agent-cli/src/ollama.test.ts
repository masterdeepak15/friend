import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "@friend/server";
import { run, type IO } from "./cli";
import { ollamaCommand } from "./commands/ollama";
import type { Runner } from "./commands/voice";

let dataDir: string;
let lines: string[];
const io = (): IO => ({ dataDir, out: (s) => lines.push(s), err: (s) => lines.push(s), ask: async () => "" });
const text = () => lines.join(" | ");

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "friend-ollama-cli-"));
  lines = [];
});

interface FakeServer {
  fetch: typeof fetch;
  calls: { url: string; method: string; body?: any }[];
  running: boolean;
  models: string[];
  pullLines: unknown[];
}

function fakeOllama(init: Partial<FakeServer> = {}): FakeServer {
  const s: FakeServer = { fetch: undefined as never, calls: [], running: true, models: ["llama3.2:3b"], pullLines: [{ status: "pulling manifest" }, { status: "success" }], ...init };
  s.fetch = (async (url: string, opts?: RequestInit) => {
    const body = opts?.body ? JSON.parse(String(opts.body)) : undefined;
    s.calls.push({ url: String(url), method: opts?.method ?? "GET", body });
    if (!s.running) throw new TypeError("fetch failed");
    if (String(url).endsWith("/api/version")) return new Response(JSON.stringify({ version: "0.40.0" }));
    if (String(url).endsWith("/api/tags")) return new Response(JSON.stringify({ models: s.models.map((name) => ({ name })) }));
    if (String(url).endsWith("/api/pull")) {
      s.models.push(body.model);
      return new Response(s.pullLines.map((l) => JSON.stringify(l)).join("\n") + "\n");
    }
    return new Response("{}", { status: 404 });
  }) as typeof fetch;
  return s;
}

const noRun: Runner = async () => ({ code: 1, stdout: "" });

describe("friend ollama status", () => {
  it("shows the server, the provider and whether the configured model is installed", async () => {
    const srv = fakeOllama({ models: ["llama3.2:3b"] });
    expect(await ollamaCommand(["status"], io(), { fetch: srv.fetch, run: noRun })).toBe(0);
    expect(text()).toMatch(/running/i);
    expect(text()).toContain("0.40.0");
    expect(text()).toContain("llama3.2:3b");
    expect(text()).toMatch(/qwen2\.5:7b.*not installed/i);
    expect(text()).toMatch(/provider:\s+claude/i);
  });

  it("says plainly when Ollama cannot be reached", async () => {
    const srv = fakeOllama({ running: false });
    expect(await ollamaCommand(["status"], io(), { fetch: srv.fetch, run: noRun })).toBe(0);
    expect(text()).toMatch(/not reachable/i);
    expect(text()).toMatch(/friend ollama setup/);
  });
});

describe("friend ollama setup", () => {
  it("pulls a missing model with progress and leaves the provider alone unless asked", async () => {
    const srv = fakeOllama({ pullLines: [{ status: "pulling manifest" }, { status: "pulling abc", total: 1000, completed: 500 }, { status: "success" }] });
    expect(await ollamaCommand(["setup"], io(), { fetch: srv.fetch, run: noRun })).toBe(0);
    const pull = srv.calls.find((c) => c.url.endsWith("/api/pull"))!;
    expect(pull.body).toEqual({ model: "qwen2.5:7b", stream: true });
    expect(text()).toMatch(/50%/);
    expect(loadConfig(dataDir).provider).toBe("claude");
    expect(text()).toMatch(/friend config set provider ollama|--use/);
  });

  it("does not download anything when the model is already installed", async () => {
    const srv = fakeOllama({ models: ["qwen2.5:7b"] });
    expect(await ollamaCommand(["setup"], io(), { fetch: srv.fetch, run: noRun })).toBe(0);
    expect(srv.calls.some((c) => c.url.endsWith("/api/pull"))).toBe(false);
    expect(text()).toMatch(/already installed/i);
  });

  it("--use switches the provider to Ollama", async () => {
    const srv = fakeOllama({ models: ["qwen2.5:7b"] });
    await ollamaCommand(["setup", "--use"], io(), { fetch: srv.fetch, run: noRun });
    expect(loadConfig(dataDir).provider).toBe("ollama");
  });

  it("a model name argument is pulled and becomes the configured model", async () => {
    const srv = fakeOllama();
    await ollamaCommand(["setup", "llama3.1:8b", "--use"], io(), { fetch: srv.fetch, run: noRun });
    expect(srv.calls.find((c) => c.url.endsWith("/api/pull"))!.body.model).toBe("llama3.1:8b");
    const cfg = loadConfig(dataDir);
    expect(cfg.ollama.model).toBe("llama3.1:8b");
    expect(cfg.provider).toBe("ollama");
  });

  it("fails clearly when the pull reports an error", async () => {
    const srv = fakeOllama({ pullLines: [{ status: "pulling manifest" }, { error: "pull model manifest: file does not exist" }] });
    expect(await ollamaCommand(["setup", "nope:1b"], io(), { fetch: srv.fetch, run: noRun })).toBe(1);
    expect(text()).toMatch(/file does not exist/);
    expect(loadConfig(dataDir).ollama.model).toBe("qwen2.5:7b"); // unchanged
  });

  it("starts a Docker container when Ollama is not running on the default local address", async () => {
    const srv = fakeOllama({ running: false });
    const commands: string[] = [];
    const run: Runner = async (cmd, args) => {
      commands.push([cmd, ...args].join(" "));
      if (args[0] === "start") return { code: 1, stdout: "No such container" };
      if (args[0] === "run") srv.running = true;
      return { code: 0, stdout: "Docker version 29" };
    };
    expect(await ollamaCommand(["setup"], io(), { fetch: srv.fetch, run, waitMs: 1000, pollMs: 10 })).toBe(0);
    expect(commands.some((c) => /^docker start friend-ollama/.test(c))).toBe(true);
    const runCmd = commands.find((c) => /^docker run/.test(c))!;
    expect(runCmd).toContain("--name friend-ollama");
    expect(runCmd).toContain("11434:11434");
    expect(runCmd).toContain("ollama/ollama");
  });

  it("explains how to install Ollama when there is neither a server nor Docker", async () => {
    const srv = fakeOllama({ running: false });
    expect(await ollamaCommand(["setup"], io(), { fetch: srv.fetch, run: noRun, waitMs: 100, pollMs: 10 })).toBe(1);
    expect(text()).toMatch(/ollama\.com|install/i);
  });

  it("never starts Docker for a custom Ollama address; it says to start it yourself", async () => {
    const cfg = loadConfig(dataDir);
    cfg.ollama.url = "http://127.0.0.1:9999";
    saveConfig(cfg);
    const srv = fakeOllama({ running: false });
    const commands: string[] = [];
    const run: Runner = async (cmd, args) => {
      commands.push([cmd, ...args].join(" "));
      return { code: 0, stdout: "" };
    };
    expect(await ollamaCommand(["setup"], io(), { fetch: srv.fetch, run, waitMs: 100, pollMs: 10 })).toBe(1);
    expect(commands).toEqual([]);
    expect(text()).toContain("http://127.0.0.1:9999");
  });

  it("rejects an unknown subcommand", async () => {
    expect(await ollamaCommand(["dance"], io(), { fetch: fakeOllama().fetch, run: noRun })).toBe(1);
  });
});

describe("provider settings in friend config", () => {
  const set = (k: string, v: string) => run(["config", "set", k, v], io());
  it("stores the provider and the Ollama settings with the right types", async () => {
    expect(await set("provider", "ollama")).toBe(0);
    expect(await set("ollama.model", "llama3.1:8b")).toBe(0);
    expect(await set("ollama.url", "http://localhost:11434")).toBe(0);
    expect(await set("ollama.contextTokens", "16384")).toBe(0);
    const cfg = loadConfig(dataDir);
    expect(cfg.provider).toBe("ollama");
    expect(cfg.ollama).toEqual({ url: "http://localhost:11434", model: "llama3.1:8b", contextTokens: 16384 });
  });
  it("rejects bad values", async () => {
    expect(await set("provider", "gpt")).toBe(1);
    expect(await set("ollama.url", "not a url")).toBe(1);
    expect(await set("ollama.url", "ftp://x")).toBe(1);
    expect(await set("ollama.contextTokens", "10")).toBe(1);
    expect(await set("ollama.contextTokens", "abc")).toBe(1);
    expect(await set("ollama.nonsense", "x")).toBe(1);
  });
});
