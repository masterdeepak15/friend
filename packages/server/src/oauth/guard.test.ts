import { describe, expect, it } from "vitest";
import { assertSafeUrl } from "./guard";

describe("assertSafeUrl", () => {
  it("accepts a public https address", () => {
    expect(assertSafeUrl("https://accounts.google.com/o/oauth2/v2/auth").hostname).toBe("accounts.google.com");
  });

  it.each([
    "http://example.com/x",
    "file:///etc/passwd",
    "javascript:alert(1)",
    "data:text/html,x",
    "https://127.0.0.1/x",
    "https://10.0.0.5/",
    "https://172.16.0.1/",
    "https://192.168.1.2/",
    "https://169.254.169.254/latest",
    "https://0.0.0.0/",
    "https://2130706433/",
    "https://0x7f000001/",
    "https://[::1]/",
    "https://[fe80::1]/",
    "https://[fd00::1]/",
    "https://[::ffff:10.0.0.1]/",
    "https://localhost/",
    "https://thing.localhost/",
    "not a url",
  ])("refuses %s", (u) => {
    expect(() => assertSafeUrl(u)).toThrow();
  });

  it("allows a server on this PC only when told to", () => {
    expect(assertSafeUrl("http://127.0.0.1:8080/mcp", { allowLoopback: true }).port).toBe("8080");
    expect(assertSafeUrl("http://localhost/mcp", { allowLoopback: true }).hostname).toBe("localhost");
    expect(() => assertSafeUrl("http://10.0.0.5/", { allowLoopback: true })).toThrow();
    expect(() => assertSafeUrl("https://169.254.169.254/", { allowLoopback: true })).toThrow();
  });
});
