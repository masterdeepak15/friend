import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { DEFAULT_OPENAI, loadConfig } from "./config";
import { SettingsError, applySettings, refuseForAgent, settingsView } from "./settings";

const fresh = () => loadConfig(mkdtempSync(join(tmpdir(), "friend-openai-")));

describe("the OpenAI-compatible provider (OmniRoute) in the settings", () => {
  it("starts with OmniRoute's address and model, and no key", () => {
    const c = fresh();
    expect(c.openai).toEqual(DEFAULT_OPENAI);
    expect(c.openai).toMatchObject({ url: "http://localhost:20128/v1", model: "auto", apiKey: null });
  });

  it("can be chosen and saved, and the provider is rebuilt", () => {
    const c = fresh();
    const r = applySettings(c, { provider: "openai", openai: { url: "http://localhost:20128/v1/", model: "auto" } });
    expect(c.provider).toBe("openai");
    expect(c.openai.url).toBe("http://localhost:20128/v1"); // the /v1 stays, a trailing slash goes
    expect(r.providerChanged).toBe(true);
  });

  it("keeps the key, never shows it, and leaves it alone when the field is empty", () => {
    const c = fresh();
    applySettings(c, { openai: { apiKey: "sk-secret-1" } });
    expect(c.openai.apiKey).toBe("sk-secret-1");
    const view = settingsView(c);
    expect(view.openai.apiKeySet).toBe(true);
    expect(JSON.stringify(view)).not.toContain("sk-secret-1");
    applySettings(c, { openai: { apiKey: "", model: "gpt-4o" } });
    expect(c.openai).toMatchObject({ apiKey: "sk-secret-1", model: "gpt-4o" });
  });

  it("never lists the key among the names of what changed", () => {
    const r = applySettings(fresh(), { openai: { apiKey: "sk-secret-2" } });
    expect(JSON.stringify(r)).not.toContain("sk-secret-2");
  });

  it("refuses an address that is not http or https, and a model name with spaces, and changes nothing", () => {
    const c = fresh();
    expect(() => applySettings(c, { openai: { url: "ftp://x/v1" } })).toThrow(SettingsError);
    expect(() => applySettings(c, { openai: { url: "nonsense" } })).toThrow(SettingsError);
    expect(() => applySettings(c, { openai: { model: "auto; rm -rf" } })).toThrow(SettingsError);
    expect(c.openai).toEqual(DEFAULT_OPENAI);
  });

  it("does not let the AI change the key", () => {
    expect(() => refuseForAgent({ openai: { apiKey: "x" } })).toThrow(/API key/);
    expect(() => refuseForAgent({ openai: { model: "auto" } })).not.toThrow();
  });
});
