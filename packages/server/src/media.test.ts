import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { openDb } from "./db";
import { MediaStore } from "./media";
import { FakeProvider } from "./provider/fake";
import { MEDIA_SRC, StageState } from "./stage";

const folder = () => mkdtempSync(join(tmpdir(), "friend-media-"));
const make = () => {
  const data = folder();
  return { data, store: new MediaStore(openDb(data), data), files: folder() };
};

describe("MediaStore.present", () => {
  it("turns an image, a clip and a PDF into a media address, with the file name as the title", async () => {
    const { store, files } = make();
    for (const [name, type] of [["a.png", "image"], ["b.gif", "image"], ["c.mp4", "video"], ["d.mp3", "video"], ["e.pdf", "pdf"]] as const) {
      writeFileSync(join(files, name), "x");
      const out = await store.present(join(files, name));
      expect(out).toMatchObject({ ok: true, type, props: { title: name } });
      if (out.ok) expect(out.props.src).toMatch(MEDIA_SRC);
    }
  });

  it("reads Markdown and text into the object, and CSV as a table", async () => {
    const { store, files } = make();
    writeFileSync(join(files, "n.md"), "# Hi");
    writeFileSync(join(files, "t.json"), '{"a":1}');
    writeFileSync(join(files, "d.csv"), 'name,note\nAnu,"likes, commas"\nRaj,"say ""hi"""\n');
    expect(await store.present(join(files, "n.md"))).toMatchObject({ ok: true, type: "markdown", props: { text: "# Hi" } });
    expect(await store.present(join(files, "t.json"))).toMatchObject({ ok: true, type: "code", props: { language: "json", code: '{"a":1}' } });
    expect(await store.present(join(files, "d.csv"))).toMatchObject({
      ok: true,
      type: "table",
      props: { columns: ["name", "note"], rows: [["Anu", "likes, commas"], ["Raj", 'say "hi"']] },
    });
  });

  it("cuts a long text file and says so", async () => {
    const { store, files } = make();
    writeFileSync(join(files, "big.txt"), "x".repeat(250_000));
    const out = await store.present(join(files, "big.txt"));
    expect(out).toMatchObject({ ok: true, type: "code" });
    if (out.ok) expect(String(out.props.code)).toMatch(/Only the first 200000 characters/);
  });

  it("gives the same file the same address and lets the screen look it up", async () => {
    const { store, files } = make();
    writeFileSync(join(files, "a.png"), "x");
    const a = await store.present(join(files, "a.png"));
    const b = await store.present(join(files, "a.png"));
    expect(a.ok && b.ok && a.props.src === b.props.src).toBe(true);
    const id = (a.ok ? String(a.props.src) : "").split("/").pop()!;
    expect(store.lookup(id)).toMatchObject({ mime: "image/png", size: 1 });
    expect(store.lookup("f".repeat(32))).toBeNull();
  });

  it("refuses what cannot or must not be shown", async () => {
    const { store, files, data } = make();
    mkdirSync(join(files, "sub"));
    writeFileSync(join(files, "bin.txt"), Buffer.from([65, 0, 66]));
    writeFileSync(join(files, "x.exe"), "x");
    writeFileSync(join(data, "config.json"), '{"apiKey":"secret"}');
    expect(await store.present("relative/path.png")).toMatchObject({ ok: false, error: expect.stringMatching(/full path/) });
    expect(await store.present(join(files, "missing.png"))).toMatchObject({ ok: false, error: expect.stringMatching(/does not exist/) });
    expect(await store.present(join(files, "sub"))).toMatchObject({ ok: false, error: expect.stringMatching(/not a file/) });
    expect(await store.present(join(files, "bin.txt"))).toMatchObject({ ok: false, error: expect.stringMatching(/not text/) });
    expect(await store.present(join(files, "x.exe"))).toMatchObject({ ok: false, error: expect.stringMatching(/cannot show \.exe/) });
    expect(await store.present(join(data, "config.json"))).toMatchObject({ ok: false, error: expect.stringMatching(/data folder/) });
  });

  it("forgets old unused grants but keeps the ones still on screen", async () => {
    const data = folder();
    let now = 1_000_000;
    const store = new MediaStore(openDb(data), data, () => now);
    const files = folder();
    writeFileSync(join(files, "a.png"), "x");
    writeFileSync(join(files, "b.png"), "x");
    const a = await store.present(join(files, "a.png"));
    const b = await store.present(join(files, "b.png"));
    const idOf = (o: typeof a) => (o.ok ? String(o.props.src).split("/").pop()! : "");
    now += 2 * 24 * 3600 * 1000;
    store.prune(new Set([idOf(b)]));
    expect(store.lookup(idOf(a))).toBeNull();
    expect(store.lookup(idOf(b))).not.toBeNull();
  });
});

describe("what the stage accepts", () => {
  const show = (stage: StageState, type: string, props: Record<string, unknown>) => stage.apply({ cmd: "show", object: { id: "x", type: type as never, props, placement: "auto" } });

  it("takes a media source only from an approved file, never a web address", () => {
    const stage = new StageState();
    expect(show(stage, "image", { src: "https://evil.example/p.png?d=secret" })).toMatchObject({ ok: false });
    expect(show(stage, "image", { src: "/api/media/../../etc/passwd" })).toMatchObject({ ok: false });
    expect(show(stage, "video", {})).toMatchObject({ ok: false });
    expect(show(stage, "image", { src: `/api/media/${"a".repeat(32)}` })).toMatchObject({ ok: true });
    expect(show(stage, "gallery", { items: [{ src: "https://x/y.png" }] })).toMatchObject({ ok: false });
    expect(show(stage, "gallery", { items: [{ src: `/api/media/${"b".repeat(32)}` }] })).toMatchObject({ ok: true });
  });

  it("checks the parts of a group and of tabs", () => {
    const stage = new StageState();
    const stat = { type: "stat", props: { label: "CPU", value: 4 } };
    expect(show(stage, "group", { items: [stat, stat] })).toMatchObject({ ok: true });
    expect(show(stage, "group", { items: [] })).toMatchObject({ ok: false });
    expect(show(stage, "group", { items: [{ type: "group", props: { items: [stat] } }] })).toMatchObject({ ok: false });
    expect(show(stage, "group", { items: [{ type: "sandbox", props: { html: "<p>x</p>" } }] })).toMatchObject({ ok: false });
    expect(show(stage, "group", { items: [{ type: "nonsense", props: {} }] })).toMatchObject({ ok: false });
    expect(show(stage, "group", { items: [{ type: "image", props: { src: "http://x/y.png" } }] })).toMatchObject({ ok: false });
    expect(show(stage, "group", { items: Array.from({ length: 9 }, () => stat) })).toMatchObject({ ok: false });
    expect(show(stage, "tabs", { tabs: [{ title: "A", ...stat }, { title: "B", type: "list", props: { items: ["x"] } }] })).toMatchObject({ ok: true });
  });
});

describe("the media and screen routes", () => {
  let app: Awaited<ReturnType<typeof createApp>> | undefined;
  afterEach(async () => {
    await app?.stop();
    app = undefined;
  });

  async function boot() {
    const data = folder();
    app = await createApp({ dataDir: data, provider: new FakeProvider([]), config: { port: 0, roots: [] } });
    const { port } = await app.start();
    const base = `http://127.0.0.1:${port}`;
    const j = { "content-type": "application/json" };
    await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify({ password: "correct horse battery", pin: "123456", assistantName: "J" }) });
    const login = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password: "correct horse battery" }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;
    const media = new MediaStore(openDb(data), data);
    return { base, cookie, media, data };
  }

  it("serves an approved file to a signed-in browser, with byte ranges for video, and nothing else", async () => {
    const { base, cookie, data } = await boot();
    const files = folder();
    writeFileSync(join(files, "clip.mp4"), "0123456789");
    // grant through the running app's own store: the same database
    const store = new MediaStore(openDb(data), data);
    const out = await store.present(join(files, "clip.mp4"));
    const src = out.ok ? String(out.props.src) : "";
    expect((await fetch(base + src)).status).toBe(401); // not signed in
    const whole = await fetch(base + src, { headers: { cookie } });
    expect(whole.status).toBe(200);
    expect(whole.headers.get("content-type")).toMatch(/video\/mp4/);
    expect(await whole.text()).toBe("0123456789");
    const part = await fetch(base + src, { headers: { cookie, range: "bytes=2-4" } });
    expect(part.status).toBe(206);
    expect(part.headers.get("content-range")).toBe("bytes 2-4/10");
    expect(await part.text()).toBe("234");
    const tail = await fetch(base + src, { headers: { cookie, range: "bytes=-3" } });
    expect(await tail.text()).toBe("789");
    expect((await fetch(base + src, { headers: { cookie, range: "bytes=50-60" } })).status).toBe(416);
    expect((await fetch(`${base}/api/media/${"0".repeat(32)}`, { headers: { cookie } })).status).toBe(404);
    expect((await fetch(`${base}/api/media/not-an-id`, { headers: { cookie } })).status).toBe(404);
  });

  it("locks an SVG picture down so it cannot run anything", async () => {
    const { base, cookie, data } = await boot();
    const files = folder();
    writeFileSync(join(files, "p.svg"), "<svg xmlns='http://www.w3.org/2000/svg'><script>alert(1)</script></svg>");
    const out = await new MediaStore(openDb(data), data).present(join(files, "p.svg"));
    const res = await fetch(base + (out.ok ? String(out.props.src) : ""), { headers: { cookie } });
    expect(res.headers.get("content-security-policy")).toMatch(/sandbox/);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("takes a screen picture only from a signed-in browser, and only when someone waits for it", async () => {
    const { base, cookie } = await boot();
    const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3]);
    const send = (headers: Record<string, string>) => fetch(`${base}/api/screen/frame/some-id`, { method: "POST", headers: { "content-type": "image/jpeg", ...headers }, body: jpeg });
    expect((await send({})).status).toBe(401);
    expect((await send({ cookie })).status).toBe(404);
  });
});
