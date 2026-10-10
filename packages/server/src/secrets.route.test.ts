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
  app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "friend-secret-")), provider: new FakeProvider([]), config: { port: 0, roots: [] } });
  const { port } = await app.start();
  const base = `http://127.0.0.1:${port}`;
  const j = { "content-type": "application/json" };
  await fetch(`${base}/api/setup`, { method: "POST", headers: j, body: JSON.stringify(owner) });
  const login = async (password: string) => {
    const r = await fetch(`${base}/api/login`, { method: "POST", headers: j, body: JSON.stringify({ password }) });
    return { status: r.status, cookie: (r.headers.get("set-cookie") ?? "").split(";")[0]! };
  };
  const change = (cookie: string, body: unknown) => fetch(`${base}/api/account/secret`, { method: "POST", headers: { ...j, cookie }, body: JSON.stringify(body) });
  const signedIn = async (cookie: string) => ((await (await fetch(`${base}/api/session`, { headers: { cookie } })).json()) as { signedIn: boolean }).signedIn;
  return { base, login, change, signedIn, verifyPin: () => app!.auth.verifyPin.bind(app!.auth) };
}

describe("changing the password and PIN", () => {
  it("changes the password: the new one signs in, the old one no longer does, other browsers are signed out, this one stays", async () => {
    const { login, change, signedIn } = await boot();
    const mine = (await login(owner.password)).cookie;
    const other = (await login(owner.password)).cookie;
    const res = await change(mine, { current: owner.password, newPassword: "a brand new password" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, signedOutOthers: true });
    expect(await signedIn(mine)).toBe(true);
    expect(await signedIn(other)).toBe(false);
    expect((await login(owner.password)).status).toBe(401);
    expect((await login("a brand new password")).status).toBe(200);
  });

  it("changes only the PIN without signing anyone out", async () => {
    const { login, change, signedIn } = await boot();
    const mine = (await login(owner.password)).cookie;
    const other = (await login(owner.password)).cookie;
    const res = await change(mine, { current: owner.password, newPin: "987654" });
    expect(await res.json()).toEqual({ ok: true, signedOutOthers: false });
    expect(await signedIn(other)).toBe(true);
    expect(await app!.auth.verifyPin("987654", "1.1.1.1")).toBe(true);
    expect(await app!.auth.verifyPin("123456", "1.1.1.1")).toBe(false);
  });

  it("needs the current password, and wrong guesses count down to the same lock as sign-in", async () => {
    const { login, change } = await boot();
    const mine = (await login(owner.password)).cookie;
    const first = await change(mine, { current: "not it", newPassword: "another good password" });
    expect(first.status).toBe(401);
    expect(await first.json()).toMatchObject({ triesLeft: 2 });
    await change(mine, { current: "not it either", newPassword: "another good password" });
    const third = await change(mine, { current: "still not", newPassword: "another good password" });
    expect(third.status).toBe(401);
    expect(await third.json()).toMatchObject({ triesLeft: 0, retryAfterSeconds: 60 });
    expect((await change(mine, { current: owner.password, newPassword: "another good password" })).status).toBe(429);
  });

  it("refuses a short password, a short PIN and an empty change, and changes nothing", async () => {
    const { login, change } = await boot();
    const mine = (await login(owner.password)).cookie;
    for (const body of [{ current: owner.password, newPassword: "short" }, { current: owner.password, newPin: "12345" }, { current: owner.password, newPin: "12ab56" }, { current: owner.password }]) {
      expect((await change(mine, body)).status).toBe(400);
    }
    expect((await login(owner.password)).status).toBe(200);
  });

  it("is only for a browser that is signed in", async () => {
    const { change } = await boot();
    expect((await change("", { current: owner.password, newPassword: "a brand new password" })).status).toBe(401);
  });
});
