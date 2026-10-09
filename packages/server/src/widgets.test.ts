import type { ServerMsg, StageObject } from "@friend/protocol";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "./app";
import { describeDevice, placeObject } from "./agent/layout";
import { openDb } from "./db";
import { FakeProvider } from "./provider/fake";
import type { ProviderEvent } from "./provider/types";
import { MAX_PINNED, StageState, runStageTool } from "./stage";
import { dbWidgetStore } from "./widgets";

const card = (id: string, extra: Partial<StageObject> = {}): StageObject => ({ id, type: "card", props: { text: id }, placement: "center", ...extra });
const show = (s: StageState, o: StageObject, now = 0) => s.apply({ cmd: "show", object: o }, now);
const phone = { width: 390, height: 844, kind: "phone" as const, orientation: "portrait" as const, touch: true };
const desk = { width: 1920, height: 1080, kind: "desktop" as const, orientation: "landscape" as const, touch: false };

describe("pinned widgets", () => {
  it("stay when the temporary pictures are cleared, and the AI is told so", () => {
    const s = new StageState();
    show(s, card("clock", { pinned: true }));
    show(s, card("answer"));
    const out: ServerMsg[] = [];
    const r = runStageTool("stage.clear", {}, s, (m) => out.push(m));
    expect(r.ok && r.output).toMatch(/1 pinned widget stays/);
    expect(s.snapshot().objects.map((o) => o.id)).toEqual(["clock"]);
  });

  it("can not be hidden or unpinned by the AI's hide, but the owner can remove them", () => {
    const s = new StageState();
    show(s, card("todo", { pinned: true }));
    const refused = s.apply({ cmd: "hide", id: "todo" });
    expect(refused).toMatchObject({ ok: false });
    expect((refused as { error: string }).error).toMatch(/pinned widget/);
    expect(s.apply({ cmd: "hide", id: "todo" }, Date.now(), true).ok).toBe(true);
    expect(s.snapshot().objects).toEqual([]);
  });

  it("never expire, even when shown with a time limit", () => {
    const s = new StageState();
    show(s, card("note", { pinned: true, ttl: 5 }), 0);
    show(s, card("passing", { ttl: 5 }), 0);
    expect(s.expire(60_000)).toEqual(["passing"]);
    expect(s.snapshot().objects.map((o) => o.id)).toEqual(["note"]);
  });

  it("keep the place the owner gave them when the AI shows the same widget again with new content", () => {
    const s = new StageState();
    show(s, card("todo", { pinned: true, placement: "left" }));
    s.apply({ cmd: "place", id: "todo", placement: { x: 0.5, y: 0.3, w: 0.3, h: 0.3 } }, 0, true);
    show(s, card("todo", { placement: "right", props: { text: "new" } }));
    const o = s.snapshot().objects[0]!;
    expect(o.pinned).toBe(true);
    expect(o.placement).toEqual({ x: 0.5, y: 0.3, w: 0.3, h: 0.3 });
    expect(o.props).toEqual({ text: "new" });
  });

  it("can be pinned and unpinned by id, and only so many fit", () => {
    const s = new StageState();
    for (let i = 0; i < MAX_PINNED; i++) show(s, card(`w${i}`, { pinned: true }));
    show(s, card("extra"));
    expect(s.apply({ cmd: "pin", id: "extra" })).toMatchObject({ ok: false });
    expect(s.apply({ cmd: "pin", id: "nothing" })).toMatchObject({ ok: false });
    expect(show(s, card("again", { pinned: true }))).toMatchObject({ ok: false });
    expect(s.apply({ cmd: "unpin", id: "w0" }).ok).toBe(true);
    expect(s.apply({ cmd: "pin", id: "extra" }).ok).toBe(true);
    expect(s.snapshot().objects.find((o) => o.id === "w0")?.pinned).toBeUndefined();
  });

  it("go back to the bare presence once the temporary pictures are gone", () => {
    const s = new StageState();
    show(s, card("widget", { pinned: true }));
    s.apply({ cmd: "scene", mode: "multi" });
    show(s, card("answer"));
    expect(s.apply({ cmd: "hide", id: "answer" })).toEqual({ ok: true, follow: [{ cmd: "scene", mode: "conversation" }] });
    expect(s.snapshot().scene).toBe("conversation");
  });

  it("are saved, and come back after a restart exactly as the owner left them", () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "friend-widgets-")));
    const first = new StageState();
    first.useStore(dbWidgetStore(db));
    show(first, card("clock", { pinned: true, placement: { x: 0.7, y: 0.1, w: 0.2, h: 0.2 } }));
    show(first, card("passing")); // temporary: not saved
    first.apply({ cmd: "update", id: "clock", props: { text: "12:00" } });
    first.apply({ cmd: "place", id: "clock", placement: { x: 0.1, y: 0.2, w: 0.25, h: 0.3 } }, 0, true);

    const second = new StageState();
    second.useStore(dbWidgetStore(db));
    expect(second.snapshot().objects).toEqual([{ id: "clock", type: "card", props: { text: "12:00" }, placement: { x: 0.1, y: 0.2, w: 0.25, h: 0.3 }, pinned: true }]);

    second.apply({ cmd: "hide", id: "clock" }, 0, true); // removed on purpose: gone for good
    const third = new StageState();
    third.useStore(dbWidgetStore(db));
    expect(third.snapshot().objects).toEqual([]);
  });

  it("a damaged saved widget is skipped, not fatal", () => {
    const db = openDb(mkdtempSync(join(tmpdir(), "friend-widgets-")));
    db.prepare("insert into widgets (id, object_json, position) values ('bad', '{nope', 0), ('odd', '{\"id\":1}', 1)").run();
    const s = new StageState();
    s.useStore(dbWidgetStore(db));
    expect(s.snapshot().objects).toEqual([]);
  });
});

describe("knowing the screen", () => {
  it("tells the model what it is drawing on, and how that changes the layout", () => {
    expect(describeDevice(phone)).toMatch(/phone, portrait, 390x844 px, touch.*stack in one column.*at most 2/);
    expect(describeDevice(desk)).toMatch(/desktop, landscape, 1920x1080 px.*all regions work/);
    expect(describeDevice({ ...desk, kind: "tablet", width: 1024, height: 768, touch: true })).toMatch(/tablet.*left.*right/);
    expect(describeDevice(null)).toMatch(/size unknown/);
  });

  it("is part of what is sent with every request, with the view and the pinned widgets", () => {
    const s = new StageState();
    s.trackView(() => "companion");
    s.setScreen(phone);
    show(s, card("clock", { pinned: true }), 0);
    const text = s.summary(0);
    expect(text).toMatch(/^screen: phone, portrait, 390x844 px/);
    expect(text).toContain("view=companion");
    expect(text).toContain("clock (card, stacked, pinned widget)");
    expect(text).not.toMatch(/free regions/); // regions mean nothing on a phone
  });

  it("is left out when unknown, so nothing else about the summary changes", () => {
    const s = new StageState();
    expect(s.summary(0)).toBe("scene=conversation; presence=idle; the stage is empty; free regions: center, left, right, top, bottom");
  });

  it("makes everything a stacked, automatic placement on a phone, and says so", () => {
    const placed = placeObject(card("chart", { placement: "right" }), [], [], phone);
    expect(placed.object.placement).toBe("auto");
    expect(placed.note).toMatch(/phone/);
    expect(placeObject(card("x", { placement: "auto" }), [], [], phone).note).toBeUndefined();
    expect(placeObject(card("y", { placement: "right" }), [], [], desk).object.placement).toBe("right");
  });
});

// ---- through the whole app ---------------------------------------------------------------------------------------------

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
const text = (t: string): ProviderEvent => ({ type: "text_delta", text: t });
const done: ProviderEvent = { type: "done" };
type App = Awaited<ReturnType<typeof createApp>>;
let app: App | undefined;
const sockets: WebSocket[] = [];

async function boot(dataDir: string, script: ProviderEvent[][] = []) {
  const provider = new FakeProvider(script);
  app = await createApp({ dataDir, provider, config: { port: 0, roots: [] }, expireIntervalMs: 100 });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const j = { "content-type": "application/json" };
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
  const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: owner.password }) });
  const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
  const connect = async () => {
    const msgs: ServerMsg[] = [];
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`, { headers: { cookie, origin: base } });
    sockets.push(ws);
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await new Promise<void>((res) => {
      ws.on("open", () => res());
      ws.on("error", () => res());
    });
    return { ws, msgs, send: (m: unknown) => ws.send(JSON.stringify(m)) };
  };
  return { provider, connect, port };
}
async function until(cond: () => boolean, ms = 4000) {
  const t = Date.now();
  while (!cond()) {
    if (Date.now() - t > ms) throw new Error("timed out waiting for condition");
    await new Promise((r) => setTimeout(r, 15));
  }
}
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await app?.stop();
  app = undefined;
});

describe("the screen and widgets through the app", () => {
  it("passes what the screen is to the model with the next request", async () => {
    const { provider, connect } = await boot(mkdtempSync(join(tmpdir(), "friend-screen-")), [[text("ok"), done]]);
    const c = await connect();
    c.send({ type: "ui.screen", ...phone });
    await new Promise((r) => setTimeout(r, 100));
    c.send({ type: "chat.send", text: "hello" });
    await until(() => provider.calls.length === 1);
    expect(provider.calls[0]!.context).toMatch(/screen: phone, portrait, 390x844/);
  });

  it("refuses a nonsense screen report without breaking the connection", async () => {
    const { connect } = await boot(mkdtempSync(join(tmpdir(), "friend-screen-")));
    const c = await connect();
    c.send({ type: "ui.screen", width: -5, height: 0, kind: "fridge", orientation: "sideways", touch: "yes" });
    await until(() => c.msgs.some((m) => m.type === "error"));
    expect(c.ws.readyState).toBe(WebSocket.OPEN);
  });

  it("lets the owner pin, move and remove a widget, tells every screen, and keeps it across a restart and a new login", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-screen-"));
    const first = await boot(dir, [[{ type: "tool_call", id: "t1", name: "stage.show", args: { object: { id: "todo", type: "card", props: { text: "milk" }, placement: "right" } } }, done], [text("Shown."), done]]);
    const c = await first.connect();
    c.send({ type: "chat.send", text: "show my list" });
    await until(() => c.msgs.some((m) => m.type === "stage" && m.command.cmd === "show"));

    c.send({ type: "stage.pin", objectId: "todo", pinned: true });
    await until(() => c.msgs.some((m) => m.type === "stage" && m.command.cmd === "pin"));
    c.send({ type: "stage.move", objectId: "todo", rect: { x: 0.6, y: 0.2, w: 0.3, h: 0.3 } });
    await until(() => c.msgs.some((m) => m.type === "stage" && m.command.cmd === "place"));
    const placed = c.msgs.find((m) => m.type === "stage" && m.command.cmd === "place") as Extract<ServerMsg, { type: "stage" }>;
    expect(placed.command).toMatchObject({ cmd: "place", id: "todo", placement: { x: 0.6, y: 0.2, w: 0.3, h: 0.3 } });

    await app!.stop();
    app = undefined;
    sockets.splice(0).forEach((s) => s.terminate());

    const second = await boot(dir); // the server restarted; the owner logs in again
    const c2 = await second.connect();
    await until(() => c2.msgs.some((m) => m.type === "snapshot"));
    const snap = c2.msgs.find((m) => m.type === "snapshot") as Extract<ServerMsg, { type: "snapshot" }>;
    expect(snap.stage.objects).toEqual([{ id: "todo", type: "card", props: { text: "milk" }, placement: { x: 0.6, y: 0.2, w: 0.3, h: 0.3 }, pinned: true }]);

    c2.send({ type: "stage.event", objectId: "todo", event: "dismiss" }); // the owner's own X removes it for good
    await until(() => c2.msgs.some((m) => m.type === "stage" && m.command.cmd === "hide"));
    expect(app!.db.prepare("select count(*) n from widgets").get()).toEqual({ n: 0 });
  });

  it("keeps the moved box inside the safe part of the screen", async () => {
    const { connect } = await boot(mkdtempSync(join(tmpdir(), "friend-screen-")), [[{ type: "tool_call", id: "t1", name: "stage.show", args: { object: { id: "a", type: "card", props: {}, placement: "center" } } }, done]]);
    const c = await connect();
    c.send({ type: "chat.send", text: "x" });
    await until(() => c.msgs.some((m) => m.type === "stage" && m.command.cmd === "show"));
    c.send({ type: "stage.move", objectId: "a", rect: { x: 0, y: 0, w: 1, h: 1 } });
    await until(() => c.msgs.some((m) => m.type === "stage" && m.command.cmd === "place"));
    const p = (c.msgs.find((m) => m.type === "stage" && m.command.cmd === "place") as Extract<ServerMsg, { type: "stage" }>).command as { placement: { x: number; y: number; w: number; h: number } };
    expect(p.placement.y).toBeGreaterThanOrEqual(0.1); // not over the top strip
    expect(p.placement.y + p.placement.h).toBeLessThanOrEqual(0.78 + 1e-9); // not over the captions and the status line
  });
});
