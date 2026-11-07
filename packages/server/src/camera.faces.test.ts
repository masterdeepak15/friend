import type { ServerMsg } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "./app";
import { CameraBroker } from "./camera";
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

describe("CameraBroker with face numbers", () => {
  const sent: ServerMsg[] = [];
  const emit = (m: ServerMsg) => sent.push(m);
  const idOf = () => (sent.find((m) => m.type === "camera.request") as { id: string }).id;

  it("asks the browser to find faces only when told to", () => {
    sent.length = 0;
    void new CameraBroker().request(emit, new AbortController().signal, undefined, true);
    expect(sent[0]).toMatchObject({ type: "camera.request", recognise: true });
    sent.length = 0;
    void new CameraBroker().request(emit, new AbortController().signal);
    expect(sent[0]).not.toHaveProperty("recognise");
  });

  it("keeps up to five faces of 128 numbers and hands them back with the picture", async () => {
    sent.length = 0;
    const b = new CameraBroker();
    const p = b.request(emit, new AbortController().signal, undefined, true);
    expect(b.setFaces(idOf(), [face(1), face(2)])).toBe("ok");
    b.deliver(idOf(), JPEG);
    expect(await p).toMatchObject({ ok: true, faces: [face(1), face(2)] });
  });

  it("refuses numbers that cannot be faces, and faces for a request nobody is waiting on", () => {
    sent.length = 0;
    const b = new CameraBroker();
    void b.request(emit, new AbortController().signal, undefined, true);
    expect(b.setFaces(idOf(), [[1, 2, 3]])).toBe("invalid");
    expect(b.setFaces(idOf(), [Array(DIM).fill(NaN)])).toBe("invalid");
    expect(b.setFaces(idOf(), Array.from({ length: 6 }, (_, i) => face(i)))).toBe("invalid");
    expect(b.setFaces("other", [face(1)])).toBe("unknown");
  });

  it("does not take faces for a request that did not ask for them", () => {
    sent.length = 0;
    const b = new CameraBroker();
    void b.request(emit, new AbortController().signal);
    expect(b.setFaces(idOf(), [face(1)])).toBe("invalid");
  });
});

describe("recognition through the whole path", () => {
  type App = Awaited<ReturnType<typeof createApp>>;
  let app: App;
  let port = 0;
  let dataDir = "";
  let provider: FakeProvider & { vision?: boolean };
  const sockets: WebSocket[] = [];
  const base = () => `http://127.0.0.1:${port}`;
  const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
  const snap: ProviderEvent = { type: "tool_call", id: "c1", name: "camera.snap", args: {} };
  const done: ProviderEvent = { type: "done" };

  async function boot(introduce: (people: People) => void = () => {}, script?: ProviderEvent[][]) {
    dataDir = mkdtempSync(join(tmpdir(), "friend-faces-"));
    provider = Object.assign(new FakeProvider(script ?? [[snap, done], [{ type: "text_delta", text: "ok" }, done]]), { vision: true });
    app = await createApp({ dataDir, provider, config: { port: 0, roots: [] }, approvalTimeoutMs: 5000, expireIntervalMs: 100 });
    port = (await app.start()).port;
    introduce(new People(app.db, dataDir));
    const j = { "content-type": "application/json" };
    await fetch(base() + "/api/setup", { method: "POST", headers: j, body: JSON.stringify(owner) });
    const res = await fetch(base() + "/api/login", { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
    const cookie = (res.headers.get("set-cookie") ?? "").split(";")[0]!;
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base() } });
    sockets.push(ws);
    const msgs: ServerMsg[] = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await new Promise<void>((r) => ws.on("open", () => r()));
    return { cookie, ws, msgs };
  }
  const until = async (cond: () => boolean, ms = 4000) => {
    const t = Date.now();
    while (!cond()) {
      if (Date.now() - t > ms) throw new Error("timed out waiting for condition");
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  async function ask(t: { ws: WebSocket; msgs: ServerMsg[] }) {
    t.ws.send(JSON.stringify({ type: "chat.send", text: "who is this?" }));
    await until(() => t.msgs.some((m) => m.type === "approval.request"));
    const card = t.msgs.find((m) => m.type === "approval.request") as { id: string };
    t.ws.send(JSON.stringify({ type: "approval.respond", id: card.id, decision: "approve" }));
    await until(() => t.msgs.some((m) => m.type === "camera.request"));
    return t.msgs.find((m) => m.type === "camera.request") as { id: string; recognise?: boolean };
  }
  const postFaces = (cookie: string | null, id: string, faces: unknown) =>
    fetch(`${base()}/api/camera/faces/${id}`, { method: "POST", headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) }, body: JSON.stringify({ faces }) });
  const postFrame = (cookie: string, id: string) => fetch(`${base()}/api/camera/frame/${id}`, { method: "POST", headers: { cookie, "content-type": "image/jpeg" }, body: new Uint8Array(JPEG) });
  const toolText = () => JSON.stringify(provider.calls[1]?.messages.at(-1) ?? null);

  afterEach(async () => {
    for (const s of sockets.splice(0)) s.terminate();
    await app.stop();
  });

  it("names an introduced person and counts the others, and keeps no face numbers anywhere", async () => {
    const t = await boot((p) => p.introduce({ name: "Priya", relation: "sister", embedding: face(1) }));
    const req = await ask(t);
    expect(req).toMatchObject({ recognise: true });
    expect((await postFaces(t.cookie, req.id, [face(1), face(7)])).status).toBe(200);
    expect((await postFrame(t.cookie, req.id)).status).toBe(200);
    await until(() => provider.calls.length === 2);
    expect(toolText()).toContain("Priya (sister)");
    expect(toolText()).toMatch(/1 person I do not know/);
    const kept = JSON.stringify([app.db.prepare("select content_json from messages").all(), app.db.prepare("select * from audit_log").all()]);
    expect(kept).not.toContain(String(face(7)[3]));
    expect(kept).not.toContain(String(face(1)[3]));
    expect(app.db.prepare("select count(*) as c from person_faces").get()).toEqual({ c: 1 }); // the stranger was not kept
  });

  it("does not ask the browser to look for faces when nobody has been introduced", async () => {
    const t = await boot();
    const req = await ask(t);
    expect(req.recognise).toBeUndefined();
  });

  it("refuses bad face numbers, an unknown request and a stranger", async () => {
    const t = await boot((p) => p.introduce({ name: "Priya", embedding: face(1) }));
    const req = await ask(t);
    expect((await postFaces(t.cookie, req.id, [[1, 2, 3]])).status).toBe(400);
    expect((await postFaces(t.cookie, "nobody", [face(1)])).status).toBe(404);
    expect((await postFaces(null, req.id, [face(1)])).status).toBe(401);
    expect((await postFaces(t.cookie, req.id, "not a list")).status).toBe(400);
  });

  it("a clip request reaches the browser with its frames and seconds, and the model gets every frame once they are all in", async () => {
    const watch: ProviderEvent = { type: "tool_call", id: "w1", name: "camera.watch", args: { seconds: 3, frames: 3 } };
    const t = await boot(() => {}, [[watch, done], [{ type: "text_delta", text: "ok" }, done]]);
    const req = await ask(t);
    expect(req).toMatchObject({ frames: 3, seconds: 3 });
    for (let i = 0; i < 3; i++) expect((await postFrame(t.cookie, req.id)).status).toBe(200);
    await until(() => provider.calls.length === 2);
    const content = provider.calls[1]!.messages.at(-1)!.content as { type: string }[];
    expect(content.filter((c) => c.type === "image")).toHaveLength(3);
    expect(t.msgs.filter((m) => m.type === "camera.cancel")).toHaveLength(1); // the other tabs are told once, when the whole clip is in
  });
});
