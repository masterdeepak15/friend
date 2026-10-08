import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "./app";
import { FakeProvider } from "./provider/fake";
import type { ProviderEvent } from "./provider/types";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const snapCall: ProviderEvent = { type: "tool_call", id: "c1", name: "camera.snap", args: {} };
const done: ProviderEvent = { type: "done" };
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fake jpeg body")]);

type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let port = 0;
let provider: FakeProvider & { vision?: boolean };
const sockets: WebSocket[] = [];
const base = () => `http://127.0.0.1:${port}`;

async function boot(opts: { cameraTimeoutMs?: number; script?: ProviderEvent[][] } = {}) {
  provider = Object.assign(new FakeProvider(opts.script ?? [[snapCall, done], [text("A mug."), done]]), { vision: true });
  app = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "friend-camroute-")),
    provider,
    config: { port: 0, roots: [] },
    cameraTimeoutMs: opts.cameraTimeoutMs,
    approvalTimeoutMs: 5000,
    expireIntervalMs: 100,
  });
  port = (await app.start()).port;
}

async function login(): Promise<string> {
  const j = { "content-type": "application/json" };
  await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
  const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0]!;
}

class Client {
  msgs: ServerMsg[] = [];
  ws!: WebSocket;
  static async connect(cookie: string): Promise<Client> {
    const c = new Client();
    c.ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base() } });
    sockets.push(c.ws);
    c.ws.on("message", (d) => c.msgs.push(JSON.parse(String(d))));
    await new Promise<void>((res) => {
      c.ws.on("open", () => res());
      c.ws.on("error", () => res());
    });
    return c;
  }
  send(m: unknown) {
    this.ws.send(JSON.stringify(m));
  }
  of<T extends ServerMsg["type"]>(t: T) {
    return this.msgs.filter((m) => m.type === t) as Extract<ServerMsg, { type: T }>[];
  }
}

async function until(cond: () => boolean, ms = 4000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
}
const pause = (ms = 150) => new Promise((r) => setTimeout(r, ms));
const upload = (cookie: string | null, id: string, body: Buffer | string = JPEG) =>
  fetch(`${base()}/api/camera/frame/${id}`, {
    method: "POST",
    headers: { ...(cookie ? { cookie } : {}), "content-type": "image/jpeg" },
    body: typeof body === "string" ? body : new Uint8Array(body),
  });

/** Starts a turn that asks for the camera, approves the card, and returns the request id the browser got. */
async function askAndApprove(c: Client) {
  c.send({ type: "chat.send", text: "what is this?" });
  await until(() => c.of("approval.request").length === 1);
  c.send({ type: "approval.respond", id: c.of("approval.request")[0]!.id, decision: "approve" });
  await until(() => c.of("camera.request").length === 1);
  return c.of("camera.request")[0]!.id;
}
const toolResultText = () => JSON.stringify(provider.calls[1]?.messages.at(-1) ?? null);

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app.stop();
});

describe("camera round trip", () => {
  it("asks only after the owner approves, then gives the model the uploaded picture", async () => {
    await boot();
    const cookie = await login();
    const c = await Client.connect(cookie);
    c.send({ type: "chat.send", text: "what is this?" });
    await until(() => c.of("approval.request").length === 1);
    await pause();
    expect(c.of("camera.request")).toEqual([]); // nothing is asked of the browser before approval
    c.send({ type: "approval.respond", id: c.of("approval.request")[0]!.id, decision: "approve" });
    await until(() => c.of("camera.request").length === 1);
    const id = c.of("camera.request")[0]!.id;

    expect((await upload(cookie, id)).status).toBe(200);
    await until(() => provider.calls.length === 2);
    const last = provider.calls[1]!.messages.at(-1)!;
    expect(last.content[1]).toEqual({ type: "image", mime: "image/jpeg", data: JPEG.toString("base64") });
    await until(() => c.msgs.some((m) => m.type === "caption.end"));

    // the picture was shown to the model but never kept
    const stored = JSON.stringify(db(app));
    expect(stored).not.toContain(JPEG.toString("base64"));
    expect(stored).toContain("[camera picture, not kept]");
    const audit = JSON.stringify(app.db.prepare("select * from audit_log").all());
    expect(audit).not.toContain(JPEG.toString("base64"));
    expect(audit).toContain("camera.frame");
  });

  it("a denial from the browser reaches the model as a plain reason", async () => {
    await boot();
    const cookie = await login();
    const c = await Client.connect(cookie);
    const id = await askAndApprove(c);
    c.send({ type: "camera.denied", id, reason: "off" });
    await until(() => provider.calls.length === 2);
    expect(toolResultText()).toContain("The owner has the camera switched off.");
  });

  it("gives up when the browser never answers", async () => {
    await boot({ cameraTimeoutMs: 200 });
    const cookie = await login();
    const c = await Client.connect(cookie);
    await askAndApprove(c);
    await until(() => provider.calls.length === 2);
    expect(toolResultText()).toContain("did not answer in time");
  });

  it("emergency lock cancels the request in every browser and nothing reaches the model", async () => {
    await boot();
    const cookie = await login();
    const c = await Client.connect(cookie);
    const id = await askAndApprove(c);
    expect((await fetch(base() + "/api/lock", { method: "POST", headers: { cookie } })).status).toBe(200);
    await until(() => c.of("camera.cancel").length >= 1);
    expect(c.of("camera.cancel")[0]!.id).toBe(id);
    expect(app.camera.pendingId()).toBeNull();
  });

  it("the first answer wins: the other tab is told to stop", async () => {
    await boot();
    const cookie = await login();
    const first = await Client.connect(cookie);
    const second = await Client.connect(cookie);
    const id = await askAndApprove(first);
    await until(() => second.of("camera.request").length === 1);
    expect((await upload(cookie, id)).status).toBe(200);
    await until(() => second.of("camera.cancel").length === 1);
    expect(second.of("camera.cancel")[0]!.id).toBe(id);
  });
});

describe("POST /api/camera/frame/:id", () => {
  it("needs a logged-in session", async () => {
    await boot();
    await login();
    expect((await upload(null, "whatever")).status).toBe(401);
  });

  it("answers 404 for an id nobody asked for and for a second upload of the same request", async () => {
    await boot();
    const cookie = await login();
    const c = await Client.connect(cookie);
    expect((await upload(cookie, "nobody-asked")).status).toBe(404);
    const id = await askAndApprove(c);
    expect((await upload(cookie, id)).status).toBe(200);
    expect((await upload(cookie, id)).status).toBe(404);
  });

  it("refuses bytes that are not a JPEG and keeps waiting for a proper one", async () => {
    await boot();
    const cookie = await login();
    const c = await Client.connect(cookie);
    const id = await askAndApprove(c);
    expect((await upload(cookie, id, "<html>not a picture</html>")).status).toBe(400);
    expect(app.camera.pendingId()).toBe(id);
    expect((await upload(cookie, id)).status).toBe(200);
  });

  it("refuses a picture over 2 MB", async () => {
    await boot();
    const cookie = await login();
    const c = await Client.connect(cookie);
    const id = await askAndApprove(c);
    const big = Buffer.concat([JPEG, Buffer.alloc(2 * 1024 * 1024)]);
    expect((await upload(cookie, id, big)).status).toBe(413);
    expect(app.camera.pendingId()).toBe(id);
  });

  it("ignores a picture that arrives after the request timed out", async () => {
    await boot({ cameraTimeoutMs: 150 });
    const cookie = await login();
    const c = await Client.connect(cookie);
    const id = await askAndApprove(c);
    await until(() => provider.calls.length === 2);
    expect((await upload(cookie, id)).status).toBe(404);
  });

  it("is rate limited", async () => {
    await boot();
    const cookie = await login();
    const codes: number[] = [];
    for (let i = 0; i < 14; i++) codes.push((await upload(cookie, "nobody")).status);
    expect(codes).toContain(429);
  });
});

function db(a: App) {
  return a.db.prepare("select content_json from messages").all();
}
