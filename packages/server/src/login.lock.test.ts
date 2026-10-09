import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { FakeProvider } from "./provider/fake";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };
let app: Awaited<ReturnType<typeof createApp>> | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

async function boot() {
  app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "friend-lock-")), provider: new FakeProvider([]), config: { port: 0, roots: [] } });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const j = { "content-type": "application/json" };
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
  const login = (password: string) => fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password }) });
  return { base, login };
}

describe("three wrong passwords lock sign-in", () => {
  it("counts the tries down, then locks, and says for how long", async () => {
    const { login } = await boot();
    const first = await login("wrong one");
    expect(first.status).toBe(401);
    expect(await first.json()).toEqual({ error: "Invalid credentials", triesLeft: 2 });
    expect(await (await login("wrong two")).json()).toEqual({ error: "Invalid credentials", triesLeft: 1 });

    const third = await login("wrong three");
    expect(third.status).toBe(401);
    expect(await third.json()).toMatchObject({ error: expect.stringMatching(/Locked for 1 minute/), triesLeft: 0, retryAfterSeconds: 60 });

    const fourth = await login("correct horse battery"); // even the right password waits
    expect(fourth.status).toBe(429);
    const body = (await fourth.json()) as { error: string; retryAfterSeconds: number };
    expect(body.error).toMatch(/Too many wrong passwords\. Try again in (59|60) seconds?|1 minute/);
    expect(body.retryAfterSeconds).toBeGreaterThan(50);
    expect(fourth.headers.get("retry-after")).toBeTruthy();
    expect(fourth.headers.get("set-cookie")).toBeNull(); // no session while locked
  });

  it("a right password before the lock clears the count", async () => {
    const { login } = await boot();
    await login("wrong one");
    await login("wrong two");
    expect((await login(owner.password)).status).toBe(200);
    expect(await (await login("wrong again")).json()).toMatchObject({ triesLeft: 2 }); // started over
  });

  it("locks the PIN the same way: three wrong tries", async () => {
    await boot();
    for (let i = 0; i < 3; i++) expect(await app!.auth.verifyPin("000000", "9.9.9.9")).toBe(false);
    await expect(app!.auth.verifyPin(owner.pin, "9.9.9.9")).rejects.toThrow(/Too many/);
  });
});

describe("who is signed in", () => {
  it("/api/session says no without a session, no for a made-up one, and yes for a real one, and is never cached", async () => {
    const { base, login } = await boot();
    const none = await fetch(`${base}/api/session`);
    expect(await none.json()).toEqual({ signedIn: false });
    expect(none.headers.get("cache-control")).toBe("no-store");
    expect(await (await fetch(`${base}/api/session`, { headers: { cookie: "friend_session=abcdef" } })).json()).toEqual({ signedIn: false });
    const ok = await login(owner.password);
    const cookie = (ok.headers.get("set-cookie") ?? "").split(";")[0]!;
    expect(await (await fetch(`${base}/api/session`, { headers: { cookie } })).json()).toEqual({ signedIn: true });
    await fetch(`${base}/api/logout`, { method: "POST", headers: { cookie, "content-type": "application/json" }, body: "{}" });
    expect(await (await fetch(`${base}/api/session`, { headers: { cookie } })).json()).toEqual({ signedIn: false });
  });
});
