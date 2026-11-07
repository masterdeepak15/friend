import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "./app";
import { People } from "./people";
import { FakeProvider } from "./provider/fake";
import type { ProviderEvent } from "./provider/types";

const DIM = 128;
function face(seed: number): number[] {
  let s = seed * 9301 + 49297;
  return Array.from({ length: DIM }, () => {
    s = (s * 9301 + 49297) % 233280;
    return s / 233280 - 0.5;
  });
}
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from("fake jpeg body")]);
const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const j = { "content-type": "application/json" };
const snap: ProviderEvent = { type: "tool_call", id: "c1", name: "camera.snap", args: {} };
const done: ProviderEvent = { type: "done" };
const say = (t: string): ProviderEvent => ({ type: "text_delta", text: t });

type App = Awaited<ReturnType<typeof createApp>>;
let app: App;
let provider: FakeProvider & { vision?: boolean };
const sockets: WebSocket[] = [];

async function boot() {
  const dataDir = mkdtempSync(join(tmpdir(), "friend-eye-e2e-"));
  // two looks in a row: the model looks, answers, looks again after the owner is asked again
  provider = Object.assign(new FakeProvider([[snap, done], [say("I see Priya."), done], [snap, done], [say("ok"), done]]), { vision: true });
  app = await createApp({ dataDir, provider, config: { port: 0, roots: [] }, approvalTimeoutMs: 5000, expireIntervalMs: 100 });
  const port = (await app.start()).port;
  const base = `http://127.0.0.1:${port}`;
  new People(app.db, dataDir).introduce({ name: "Priya", relation: "sister", embedding: face(1) });
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base } });
  sockets.push(ws);
  const msgs: ServerMsg[] = [];
  ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
  await new Promise<void>((r) => ws.on("open", () => r()));
  const put = (settings: object, pin?: string) => fetch(`${base}/api/settings`, { method: "PUT", headers: { ...j, cookie }, body: JSON.stringify({ ...(pin ? { pin } : {}), settings }) });
  const frame = (id: string) => fetch(`${base}/api/camera/frame/${id}`, { method: "POST", headers: { cookie, "content-type": "image/jpeg" }, body: new Uint8Array(JPEG) });
  const faces = (id: string, f: number[][]) => fetch(`${base}/api/camera/faces/${id}`, { method: "POST", headers: { ...j, cookie }, body: JSON.stringify({ faces: f }) });
  return { base, cookie, ws, msgs, put, frame, faces };
}
const until = async (cond: () => boolean, ms = 4000) => {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
};
const pause = (ms = 200) => new Promise((r) => setTimeout(r, ms));
const kinds = (kind: string) => app.db.prepare("select * from audit_log where kind = ?").all(kind) as unknown[];

afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app.stop();
});

describe("the eye, end to end", () => {
  it("eye off: the owner is asked. Eye on at the screen: Friend looks by itself and says who is there. Signed out: it is off again", async () => {
    const t = await boot();
    const asked = () => t.msgs.filter((m) => m.type === "approval.request") as Extract<ServerMsg, { type: "approval.request" }>[];
    const requests = () => t.msgs.filter((m) => m.type === "camera.request") as { id: string; recognise?: boolean }[];

    // 1. the eye is off: a card appears and nothing is asked of the camera until the owner approves
    t.ws.send(JSON.stringify({ type: "chat.send", text: "what is this?" }));
    await until(() => asked().length === 1);
    await pause();
    expect(requests()).toEqual([]);
    expect(asked()[0]).toMatchObject({ tool: "camera.snap" });
    t.ws.send(JSON.stringify({ type: "approval.respond", id: asked()[0]!.id, decision: "deny" }));
    await until(() => provider.calls.length === 2);

    // 2. the eye on (needs the PIN): the next look needs no card, and the person is named
    expect((await t.put({ eye: { on: true } })).status).not.toBe(200);
    expect((await t.put({ eye: { on: true } }, owner.pin)).status).toBe(200);
    t.ws.send(JSON.stringify({ type: "chat.send", text: "who is this?" }));
    await until(() => requests().length === 1);
    expect(asked()).toHaveLength(1); // still only the first card
    expect(requests()[0]!.recognise).toBe(true);
    expect((await t.faces(requests()[0]!.id, [face(1), face(9)])).status).toBe(200);
    expect((await t.frame(requests()[0]!.id)).status).toBe(200);
    await until(() => provider.calls.length === 4);
    const toolText = JSON.stringify(provider.calls[3]!.messages.at(-1));
    expect(toolText).toContain("Priya (sister)");
    expect(toolText).toMatch(/1 person I do not know/);

    // 3. what was written down: that it looked, never the picture or the numbers
    expect(kinds("camera.look")).toHaveLength(1);
    const everything = JSON.stringify([app.db.prepare("select * from audit_log").all(), app.db.prepare("select content_json from messages").all()]);
    expect(everything).not.toContain(JPEG.toString("base64"));
    expect(everything).not.toContain(String(face(9)[3]));
    expect(everything).not.toContain(String(face(1)[3]));
    expect(app.db.prepare("select count(*) as c from person_faces").get()).toEqual({ c: 1 }); // the stranger was not kept

    // 4. signing out closes the eye
    await fetch(`${t.base}/api/logout`, { method: "POST", headers: { cookie: t.cookie } });
    const login = await fetch(`${t.base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const view = (await (await fetch(`${t.base}/api/settings`, { headers: { cookie } })).json()) as { eye: { on: boolean } };
    expect(view.eye.on).toBe(false);
    expect(kinds("eye.off").length).toBeGreaterThanOrEqual(1);
  });
});
