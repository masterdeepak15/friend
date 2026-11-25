import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { OAuthVault } from "./vault";

const dir = () => mkdtempSync(join(tmpdir(), "friend-vault-"));

describe("OAuthVault", () => {
  it("keeps what it is given, across a restart, and none of it is readable in the file", () => {
    const d = dir();
    const v = new OAuthVault(d);
    v.patch("svc:google", { tokens: { access_token: "AT-secret-123", refresh_token: "RT-secret-456" }, account: "me@example.com", issuer: "https://accounts.google.com" });
    expect(new OAuthVault(d).get("svc:google").account).toBe("me@example.com");
    expect((new OAuthVault(d).get("svc:google").tokens as { access_token: string }).access_token).toBe("AT-secret-123");
    const raw = readFileSync(join(d, "oauth-vault.json"), "utf8");
    expect(raw).not.toContain("AT-secret-123");
    expect(raw).not.toContain("RT-secret-456");
    expect(raw).not.toContain("me@example.com");
  });

  it("forgets one entry and leaves the others", () => {
    const v = new OAuthVault(dir());
    v.patch("mcp:a", { account: "a" });
    v.patch("mcp:b", { account: "b" });
    v.forget("mcp:a");
    expect(v.has("mcp:a")).toBe(false);
    expect(v.get("mcp:b").account).toBe("b");
    expect(v.keys()).toEqual(["mcp:b"]);
  });

  it("treats a damaged file as empty instead of stopping Friend", () => {
    const d = dir();
    writeFileSync(join(d, "oauth-vault.json"), "not json at all");
    const v = new OAuthVault(d);
    expect(v.keys()).toEqual([]);
    v.patch("mcp:a", { account: "a" });
    expect(new OAuthVault(d).get("mcp:a").account).toBe("a");
  });

  it("never lets a login from one authorization server be used with another", () => {
    const v = new OAuthVault(dir());
    v.patch("mcp:a", { issuer: "https://as1.example.com", tokens: { access_token: "x" }, clientInfo: { client_id: "c1" } });
    v.patch("mcp:a", { issuer: "https://as2.example.com" });
    expect(v.get("mcp:a").tokens).toBeUndefined();
    expect(v.get("mcp:a").clientInfo).toBeUndefined();
    expect(v.get("mcp:a").issuer).toBe("https://as2.example.com");
  });

  it("returns copies, so a caller cannot change what is stored", () => {
    const v = new OAuthVault(dir());
    v.patch("mcp:a", { account: "a" });
    v.get("mcp:a").account = "changed";
    expect(v.get("mcp:a").account).toBe("a");
  });
});
