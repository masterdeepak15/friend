import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { loadConfig } from "./config";
import { FakeProvider } from "./provider/fake";
import { applySettings, refuseForAgent } from "./settings";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let dir = "";
let port = 0;
const base = () => `http://127.0.0.1:${port}`;
const j = { "content-type": "application/json" };

async function boot(opts: { fake?: boolean; config?: object } = {}) {
  dir = mkdtempSync(join(tmpdir(), "friend-settings-"));
  app = await createApp({ dataDir: dir, ...(opts.fake === false ? {} : { provider: new FakeProvider([]) }), config: { port: 0, roots: [], ...opts.config } });
  port = (await app.start()).port;
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const get = (cookie: string | null) => fetch(base() + "/api/settings", { headers: cookie ? { cookie } : {} });
const put = (cookie: string | null, settings: unknown, pin: string | null = owner.pin) =>
  fetch(base() + "/api/settings", { method: "PUT", headers: { ...j, ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ ...(pin !== null ? { pin } : {}), settings }) });

afterEach(async () => {
  await app?.stop();
});

describe("settings routes", () => {
  it("need a signed-in owner", async () => {
    await boot();
    expect((await get(null)).status).toBe(401);
    expect((await put(null, { model: "x" })).status).toBe(401);
  });

  it("show the settings but never the API key", async () => {
    const cookie = await boot({ config: { apiKey: "sk-secret-123" } });
    const text = await (await get(cookie)).text();
    expect(text).not.toContain("sk-secret-123");
    expect(JSON.parse(text)).toMatchObject({ apiKeySet: true, provider: "claude", claudeCode: { model: "sonnet" }, ollama: { model: "qwen2.5:7b" }, voice: { speakTyped: true } });
  });

  it("need the PIN, and a wrong PIN changes nothing", async () => {
    const cookie = await boot();
    expect((await put(cookie, { claudeCode: { model: "haiku" } }, null)).status).toBe(400);
    expect((await put(cookie, { claudeCode: { model: "haiku" } }, "000000")).status).toBe(403);
    expect(loadConfig(dir).claudeCode.model).toBe("sonnet");
  });

  it("save a change right away and keep it for the next start", async () => {
    const cookie = await boot();
    const res = await put(cookie, { claudeCode: { model: "haiku", fallback: "none" }, voice: { speakTyped: false, accept: 0.8 }, ollama: { model: "llama3.2:3b", contextTokens: 4096 } });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { settings: { claudeCode: { model: string }; voice: { speakTyped: boolean } }; restart: string[] };
    expect(body.settings.claudeCode.model).toBe("haiku");
    expect(body.settings.voice.speakTyped).toBe(false);
    expect(body.restart).toEqual([]);
    expect(app.config.voice.speakTyped).toBe(false); // live, not only on disk
    const saved = loadConfig(dir);
    expect([saved.claudeCode.model, saved.claudeCode.fallback, saved.voice.accept, saved.ollama.model, saved.ollama.contextTokens]).toEqual(["haiku", "none", 0.8, "llama3.2:3b", 4096]);
  });

  it("store a new API key without ever sending it back, and keep the old one when left empty", async () => {
    const cookie = await boot({ config: { apiKey: "old-key" } });
    const res = await put(cookie, { apiKey: "new-key-value" });
    expect(await res.text()).not.toContain("new-key-value");
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).apiKey).toBe("new-key-value");
    await put(cookie, { apiKey: "" });
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).apiKey).toBe("new-key-value");
  });

  it("refuse values that make no sense, and change nothing", async () => {
    const cookie = await boot();
    for (const bad of [
      { provider: "gpt" },
      { claudeCode: { model: "sonnet --dangerously-skip-permissions" } },
      { claudeCode: { command: "claude && del *" } },
      { ollama: { url: "ftp://x" } },
      { ollama: { contextTokens: 5 } },
      { voice: { accept: 2 } },
      { voice: { accept: 0.5, challenge: 0.6 } },
      { bind: "0.0.0.0" }, // network settings stay in the terminal
      { roots: ["C:/"] },
    ]) {
      const res = await put(cookie, bad);
      expect(res.status, JSON.stringify(bad)).toBe(400);
    }
    expect(loadConfig(dir).claudeCode).toEqual({ model: "sonnet", command: "claude", fallback: "ollama", webSearch: true });
    expect(app.config.bind).toBe("127.0.0.1");
  });

  it("will not switch to Claude without an API key", async () => {
    const cookie = await boot({ config: { provider: "ollama" } });
    const res = await put(cookie, { provider: "claude" });
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: string }).error).toMatch(/API key/);
  });

  it("say which settings need a restart", async () => {
    const cookie = await boot();
    const res = await put(cookie, { voice: { enabled: false, sttModel: "base", ttsVoice: "en_US-amy-medium" } });
    expect(((await res.json()) as { restart: string[] }).restart).toEqual(["voice.enabled"]); // the voice and the listening model are loaded live
  });

  it("record what changed in the audit log, never the values", async () => {
    const cookie = await boot();
    await put(cookie, { apiKey: "super-secret-key" });
    const rows = app.db.prepare("select detail_json from audit_log where kind = 'settings.changed'").all() as { detail_json: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.detail_json).toContain("apiKey"); // the name of the setting, not its value
    expect(rows[0]!.detail_json).not.toContain("super-secret-key");
  });
});

describe("changing the model backend while Friend runs", () => {
  it("swaps it live, and a bad choice leaves the old one in place", async () => {
    const cookie = await boot({ fake: false, config: { provider: "ollama" } });
    expect(app.provider.id).toBe("ollama");
    expect((await put(cookie, { provider: "claude-code" })).status).toBe(200);
    expect(app.provider.id).toBe("claude-code+ollama"); // with the local model as the safety net
    expect((await put(cookie, { claudeCode: { fallback: "none" } })).status).toBe(200);
    expect(app.provider.id).toBe("claude-code");
    expect((await put(cookie, { provider: "claude" })).status).toBe(400); // no key
    expect(app.provider.id).toBe("claude-code");
    expect((await put(cookie, { provider: "ollama" })).status).toBe(200);
    expect(app.provider.id).toBe("ollama");
  });
});

describe("applySettings", () => {
  it("changes nothing when any part of the patch is refused", () => {
    const c = loadConfig(mkdtempSync(join(tmpdir(), "friend-apply-")));
    expect(() => applySettings(c, { claudeCode: { model: "haiku" }, voice: { accept: 3 } })).toThrow();
    expect(c.claudeCode.model).toBe("sonnet");
  });
});

describe("web search settings", () => {
  it("show the choices but never a key", async () => {
    const cookie = await boot({ config: { web: { enabled: true, provider: "brave", searxngUrl: "", braveKey: "BRAVE-SECRET-1", tavilyKey: "TAVILY-SECRET-2" } } });
    const text = await (await get(cookie)).text();
    expect(text).not.toContain("BRAVE-SECRET-1");
    expect(text).not.toContain("TAVILY-SECRET-2");
    expect(JSON.parse(text).web).toEqual({ enabled: true, provider: "brave", searxngUrl: "", braveKeySet: true, tavilyKeySet: true, tavily: { installed: false, enabled: false, depth: "basic", maxResults: 5 } });
  });

  it("change the source and the keys with the PIN, and keep a key when the box is left empty", async () => {
    const cookie = await boot();
    expect((await put(cookie, { web: { provider: "tavily", tavilyKey: "TVLY-1" } })).status).toBe(200);
    expect(loadConfig(dir).web).toMatchObject({ provider: "tavily", tavilyKey: "TVLY-1" });
    expect((await put(cookie, { web: { enabled: false, tavilyKey: "" } })).status).toBe(200);
    expect(loadConfig(dir).web).toMatchObject({ enabled: false, tavilyKey: "TVLY-1" });
  });

  it("refuse a source that does not exist and an address that is not a web address", async () => {
    const cookie = await boot();
    for (const bad of [{ web: { provider: "google" } }, { web: { searxngUrl: "ftp://x" } }, { web: { searxngUrl: "javascript:alert(1)" } }, { web: { braveKey: "x".repeat(300) } }, { web: { surprise: true } }]) {
      expect((await put(cookie, bad)).status, JSON.stringify(bad)).toBe(400);
    }
  });

  it("are not for the assistant to change: they hold keys and an address on the owner's network", () => {
    expect(() => refuseForAgent({ web: { braveKey: "x" } })).toThrow(/web search/i);
    expect(() => refuseForAgent({ web: { searxngUrl: "http://10.0.0.5" } })).toThrow(/web search/i);
    expect(() => refuseForAgent({ voice: { speakTyped: true } })).not.toThrow();
  });
});
