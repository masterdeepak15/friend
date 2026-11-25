import { describe, expect, it } from "vitest";
import { sanitizeOauth } from "../config";
import { redirectUri } from "./redirect";

describe("redirectUri", () => {
  it("follows the host's own public address, whatever it is", () => {
    expect(redirectUri("https://maya.example.com/", 8787)).toBe("https://maya.example.com/api/oauth/callback");
    expect(redirectUri("https://other.host.test", 8787)).toBe("https://other.host.test/api/oauth/callback");
  });
  it("falls back to this PC when there is no public address", () => {
    expect(redirectUri(null, 8787)).toBe("http://127.0.0.1:8787/api/oauth/callback");
  });
});

describe("sanitizeOauth", () => {
  it("keeps good client IDs and drops bad ones", () => {
    expect(sanitizeOauth({ clients: { google: { clientId: " 123.apps.googleusercontent.com " }, "Bad Name": { clientId: "x" }, github: { clientId: "has space" }, empty: { clientId: "" }, num: { clientId: 5 } } })).toEqual({
      clients: { google: { clientId: "123.apps.googleusercontent.com" } },
    });
  });
  it("is empty for anything that is not an object", () => {
    expect(sanitizeOauth(undefined)).toEqual({ clients: {} });
    expect(sanitizeOauth("x")).toEqual({ clients: {} });
    expect(sanitizeOauth({ clients: "x" })).toEqual({ clients: {} });
  });
});
