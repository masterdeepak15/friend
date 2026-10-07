import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Audit } from "./audit";
import { Auth } from "./auth";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { createGateway } from "./gateway";

let gw: ReturnType<typeof createGateway>;
let base = "";
let calls: { audio: Buffer; mime: string }[] = [];
let available = true;
let result: () => Promise<{ text: string }>;
const owner = { password: "correct horse battery", pin: "123456", assistantName: "J" };

beforeEach(async () => {
  calls = [];
  available = true;
  result = async () => ({ text: "hello there" });
  const dir = mkdtempSync(join(tmpdir(), "friend-gwv-"));
  const db = openDb(dir);
  const audit = new Audit(db);
  const auth = new Auth(db, audit);
  gw = createGateway({
    config: { ...loadConfig(dir), port: 0 },
    auth,
    audit,
    onClientMessage: () => {},
    onDeviceConnect: () => {},
    voiceAvailable: () => available,
    onVoiceUtterance: async (_s, audio, mime) => {
      calls.push({ audio, mime });
      return result();
    },
  });
  base = `http://127.0.0.1:${(await gw.listen()).port}`;
  await fetch(base + "/api/setup", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(owner) });
});
afterEach(async () => {
  await gw.close();
});

async function cookie(): Promise<string> {
  const res = await fetch(base + "/api/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}
const utter = (body: Uint8Array<ArrayBuffer> | string, headers: Record<string, string> = {}) =>
  fetch(base + "/api/voice/utterance", { method: "POST", headers: { "content-type": "audio/webm;codecs=opus", ...headers }, body });

describe("POST /api/voice/utterance", () => {
  it("refuses without a session and never calls the handler", async () => {
    expect((await utter("AUDIO")).status).toBe(401);
    expect((await utter("AUDIO", { cookie: "friend_session=bogus" })).status).toBe(401);
    expect(calls).toEqual([]);
  });

  it("passes the audio bytes and content type to the handler and returns the text", async () => {
    const res = await utter(new Uint8Array([1, 2, 3, 4]), { cookie: await cookie() });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "hello there" });
    expect(calls[0]!.audio.equals(Buffer.from([1, 2, 3, 4]))).toBe(true);
    expect(calls[0]!.mime).toBe("audio/webm;codecs=opus");
  });

  it("answers 503 while voice is unavailable", async () => {
    available = false;
    const res = await utter("AUDIO", { cookie: await cookie() });
    expect(res.status).toBe(503);
    expect(calls).toEqual([]);
  });

  it("rejects a body over 4 MB with 413 before the handler runs", async () => {
    // the server may answer 413 or drop the connection while the oversize body is still being sent: both reject it
    const status = await utter(new Uint8Array(4 * 1024 * 1024 + 1024), { cookie: await cookie() }).then((r) => r.status, () => 413);
    expect(status).toBe(413);
    expect(calls).toEqual([]);
  });

  it("rejects an empty body and unsupported content types", async () => {
    const c = await cookie();
    expect((await utter(new Uint8Array(0), { cookie: c })).status).toBe(400);
    expect((await utter("{}", { cookie: c, "content-type": "application/json" })).status).toBe(415);
    expect(calls).toEqual([]);
  });

  it("rate limits rapid-fire requests before doing any work", async () => {
    const c = await cookie();
    const statuses: number[] = [];
    for (let i = 0; i < 14; i++) statuses.push((await utter("AUDIO", { cookie: c })).status);
    expect(statuses.filter((s) => s === 200)).toHaveLength(10);
    expect(statuses.slice(10).every((s) => s === 429)).toBe(true);
    expect(calls).toHaveLength(10);
  });

  it("maps a handler failure to 502 with a short message", async () => {
    result = async () => {
      throw new Error("the voice sidecar timed out");
    };
    const res = await utter("AUDIO", { cookie: await cookie() });
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toMatch(/timed out/);
  });
});
