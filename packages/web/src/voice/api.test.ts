import { afterEach, describe, expect, it, vi } from "vitest";
import { postUtterance, postWake } from "./api";

afterEach(() => vi.unstubAllGlobals());

const blob = new Blob([new Uint8Array(10)], { type: "audio/webm;codecs=opus" });
const reply = (status: number, body: unknown, json = true) => ({
  ok: status >= 200 && status < 300,
  status,
  json: async () => {
    if (!json) throw new Error("no json");
    return body;
  },
});

describe("postUtterance", () => {
  it("posts the recording with its own content type and returns the heard text", async () => {
    const fetchMock = vi.fn(async () => reply(200, { text: "open the pod bay doors" }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await postUtterance(blob)).toEqual({ text: "open the pod bay doors" });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("/api/voice/utterance");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>)["content-type"]).toBe("audio/webm;codecs=opus");
    expect(init.body).toBe(blob);
  });

  it("falls back to audio/webm when the blob has no type", async () => {
    const fetchMock = vi.fn(async () => reply(200, { text: "x" }));
    vi.stubGlobal("fetch", fetchMock);
    await postUtterance(new Blob([new Uint8Array(4)]));
    expect(((fetchMock.mock.calls[0] as unknown as [string, RequestInit])[1].headers as Record<string, string>)["content-type"]).toBe("audio/webm");
  });

  it("throws the server's error message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(502, { error: "the voice sidecar timed out" })));
    await expect(postUtterance(blob)).rejects.toThrow("the voice sidecar timed out");
  });

  it("explains common statuses when the body has no message", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(503, null, false)));
    await expect(postUtterance(blob)).rejects.toThrow(/not available/i);
    vi.stubGlobal("fetch", vi.fn(async () => reply(429, null, false)));
    await expect(postUtterance(blob)).rejects.toThrow(/too fast|slow down|too many/i);
    vi.stubGlobal("fetch", vi.fn(async () => reply(401, null, false)));
    await expect(postUtterance(blob)).rejects.toThrow(/sign in/i);
  });

  it("explains a network failure", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => {
      throw new TypeError("fetch failed");
    }));
    await expect(postUtterance(blob)).rejects.toThrow(/could not reach friend/i);
  });
});

describe("postWake", () => {
  it("asks the hands-free route and says whether the name was heard", async () => {
    const fetchMock = vi.fn(async () => reply(200, { text: "open it", wake: true }));
    vi.stubGlobal("fetch", fetchMock);
    expect(await postWake(blob)).toEqual({ text: "open it", wake: true });
    expect((fetchMock.mock.calls[0] as unknown as [string])[0]).toBe("/api/voice/utterance?wake=1");
  });

  it("reads a missing wake as not woken", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(200, { text: "" })));
    expect(await postWake(blob)).toEqual({ text: "", wake: false });
  });

  it("throws what the server said, like the ordinary route", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => reply(409, {}, false)));
    await expect(postWake(blob)).rejects.toThrow("busy with the last request");
  });
});
