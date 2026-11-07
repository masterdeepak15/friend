import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { loadConfig, saveConfig } from "./config";
import { sealSecrets, unsealSecrets } from "./secretBox";

const dir = () => mkdtempSync(join(tmpdir(), "friend-box-"));
afterEach(() => {
  delete process.env.FRIEND_SECRET_KEY;
});

const sample = () => ({
  openai: { url: "http://x", apiKey: "sk-live-123456" },
  web: { tavilyKey: "tvly-abcdef" },
  channels: { telegram: { botToken: "123:ABC" }, twilio: { accountSid: "ACxxxx", authToken: "tw-token", smsFrom: "+100" } },
  model: "gpt",
});

describe("secrets in the saved file", () => {
  it("only secret-looking values are sealed, and they come back exactly", () => {
    const d = dir();
    const { value, changed } = sealSecrets(sample(), d);
    expect(changed).toBe(true);
    const text = JSON.stringify(value);
    for (const s of ["sk-live-123456", "tvly-abcdef", "123:ABC", "ACxxxx", "tw-token"]) expect(text).not.toContain(s);
    expect((value as any).openai.url).toBe("http://x");
    expect((value as any).channels.twilio.smsFrom).toBe("+100");
    expect(unsealSecrets(value, d).value).toEqual(sample());
  });

  it("sealing twice does not seal again, and each seal differs", () => {
    const d = dir();
    const a = sealSecrets(sample(), d).value;
    expect(sealSecrets(a, d).changed).toBe(false);
    expect((sealSecrets(sample(), d).value as any).openai.apiKey).not.toBe((a as any).openai.apiKey);
  });

  it("a changed byte is refused, and the value is reported as lost, not guessed", () => {
    const d = dir();
    const v: any = sealSecrets(sample(), d).value;
    v.openai.apiKey = v.openai.apiKey.slice(0, -2) + "AA";
    const r = unsealSecrets(v, d);
    expect(r.lost).toContain("openai.apiKey");
    expect(r.value.openai.apiKey).toBe("");
  });

  it("a different key cannot read it", () => {
    const v = sealSecrets(sample(), dir()).value;
    expect(unsealSecrets(v, dir()).lost.length).toBe(5);
  });

  it("FRIEND_SECRET_KEY is used instead of a key file", () => {
    const d = dir();
    process.env.FRIEND_SECRET_KEY = "my passphrase";
    const v = sealSecrets(sample(), d).value;
    expect(existsSync(join(d, "secret.key"))).toBe(false);
    expect(unsealSecrets(v, d).value).toEqual(sample());
    process.env.FRIEND_SECRET_KEY = "another";
    expect(unsealSecrets(v, d).lost.length).toBe(5);
  });
});

describe("config.json on disk", () => {
  it("never holds a key in clear, still loads it, and upgrades an old plain file", () => {
    const d = dir();
    saveConfig({ dataDir: d, openai: { url: "http://x", apiKey: "sk-live-123456", model: "m" } } as any);
    expect(readFileSync(join(d, "config.json"), "utf8")).not.toContain("sk-live-123456");
    expect(loadConfig(d).openai.apiKey).toBe("sk-live-123456");

    const old = dir();
    writeFileSync(join(old, "config.json"), JSON.stringify({ openai: { url: "http://x", apiKey: "sk-old-999999", model: "m" } }));
    expect(loadConfig(old).openai.apiKey).toBe("sk-old-999999");
    expect(readFileSync(join(old, "config.json"), "utf8")).not.toContain("sk-old-999999");
  });
});
