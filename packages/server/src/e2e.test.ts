import type { ServerMsg } from "@friend/protocol";
import { execSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { createApp } from "./app";
import { FakeProvider } from "./provider/fake";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = resolve(here, "../../web");
const dist = join(webRoot, "dist");

let app: Awaited<ReturnType<typeof createApp>>;
let base = "";

beforeAll(async () => {
  if (!existsSync(join(dist, "index.html"))) {
    execSync("pnpm build", { cwd: webRoot, stdio: "ignore", timeout: 180_000 });
  }
  const work = realpathSync(mkdtempSync(join(tmpdir(), "friend-e2e-")));
  app = await createApp({
    dataDir: mkdtempSync(join(tmpdir(), "friend-e2e-data-")),
    webDir: dist,
    config: { port: 0, roots: [work] },
    provider: new FakeProvider([
      [
        { type: "tool_call", id: "1", name: "stage.show", args: { object: { id: "hello", type: "stat", props: { label: "READY", value: 100, unit: "%" }, placement: "center" } } },
        { type: "done" },
      ],
      [{ type: "text_delta", text: "Systems online." }, { type: "done" }],
    ]),
  });
  base = `http://127.0.0.1:${(await app.start()).port}`;
}, 200_000);

afterAll(async () => {
  await app?.stop();
}, 30_000);

describe("built web client served by the gateway", () => {
  it("serves index.html at / and for unknown client routes", async () => {
    for (const path of ["/", "/anything/else"]) {
      const res = await fetch(base + path);
      expect(res.status).toBe(200);
      expect(await res.text()).toContain('<div id="root">');
    }
  });

  it("serves the JavaScript and CSS bundles referenced by index.html", async () => {
    const html = await (await fetch(base + "/")).text();
    const js = html.match(/src="(\/assets\/[^"]+\.js)"/)?.[1];
    const css = html.match(/href="(\/assets\/[^"]+\.css)"/)?.[1];
    expect(js).toBeTruthy();
    expect(css).toBeTruthy();
    const jsRes = await fetch(base + js);
    expect(jsRes.status).toBe(200);
    expect(jsRes.headers.get("content-type")).toMatch(/javascript/);
    expect((await fetch(base + css)).status).toBe(200);
  });

  it("does not expose API routes through the SPA fallback", async () => {
    expect((await fetch(base + "/api/nope")).status).toBe(404);
  });

  it("walks setup, login and a scripted turn over the real websocket", async () => {
    expect(await (await fetch(base + "/api/state")).json()).toEqual({ hasOwner: false });
    const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
    const headers = { "content-type": "application/json" };
    expect((await fetch(base + "/api/setup", { method: "POST", headers, body: JSON.stringify(owner) })).status).toBe(200);
    const login = await fetch(base + "/api/login", { method: "POST", headers, body: JSON.stringify({ password: owner.password }) });
    const cookie = (login.headers.get("set-cookie") ?? "").split(";")[0]!;

    const msgs: ServerMsg[] = [];
    const ws = new WebSocket(base.replace("http", "ws") + "/ws", { headers: { cookie, origin: base } });
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    await new Promise<void>((r) => ws.on("open", () => r()));
    ws.send(JSON.stringify({ type: "chat.send", text: "status report" }));
    const t0 = Date.now();
    while (!msgs.some((m) => m.type === "caption.end")) {
      if (Date.now() - t0 > 5000) throw new Error("no caption.end");
      await new Promise((r) => setTimeout(r, 20));
    }
    ws.close();
    expect(msgs.filter((m) => m.type === "caption.delta").map((m: any) => m.text).join("")).toBe("Systems online.");
    expect(msgs.some((m) => m.type === "stage" && m.command.cmd === "show")).toBe(true);
    expect(msgs.some((m) => m.type === "stage" && m.command.cmd === "presence" && m.command.state === "thinking")).toBe(true);
    expect(msgs.some((m) => m.type === "stage" && m.command.cmd === "presence" && m.command.state === "speaking")).toBe(true);
  });
});
