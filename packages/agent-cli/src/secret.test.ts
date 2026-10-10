import { Audit, Auth, openDb } from "@friend/server";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { run, type IO } from "./cli";

let dataDir: string;
let lines: string[];
const io = (answers: string[]): IO => ({ dataDir, out: (s) => lines.push(s), err: (s) => lines.push(s), ask: async () => answers.shift() ?? "" });

async function seed() {
  const db = openDb(dataDir);
  const auth = new Auth(db, new Audit(db));
  await auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
  const login = await auth.login("correct horse battery", "1.1.1.1");
  return { auth, login, close: () => db.close() };
}

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "friend-secret-"));
  lines = [];
});

describe("friend password / friend pin", () => {
  it("sets a new password without asking for the old one, and signs every browser out", async () => {
    const s = await seed();
    expect(await run(["password"], io(["a brand new password", "a brand new password"]))).toBe(0);
    expect(lines.join("\n")).toMatch(/Password changed/);
    expect(s.auth.resolveSession(s.login.token)).toBeNull();
    await expect(s.auth.login("correct horse battery", "2.2.2.2")).rejects.toThrow();
    await expect(s.auth.login("a brand new password", "2.2.2.2")).resolves.toBeTruthy();
    s.close();
  });

  it("sets a new PIN and leaves the sessions alone", async () => {
    const s = await seed();
    expect(await run(["pin"], io(["654321", "654321"]))).toBe(0);
    expect(s.auth.resolveSession(s.login.token)).not.toBeNull();
    expect(await s.auth.verifyPin("654321", "3.3.3.3")).toBe(true);
    s.close();
  });

  it("changes nothing when the two entries differ or the new one is too short", async () => {
    const s = await seed();
    expect(await run(["password"], io(["a brand new password", "something else"]))).toBe(1);
    expect(lines.join("\n")).toMatch(/not the same/);
    expect(await run(["password"], io(["short"]))).toBe(1);
    expect(await run(["pin"], io(["12345"]))).toBe(1);
    await expect(s.auth.login("correct horse battery", "4.4.4.4")).resolves.toBeTruthy();
    s.close();
  });

  it("says so when there is no owner yet", async () => {
    expect(await run(["pin"], io([]))).toBe(1);
    expect(lines.join("\n")).toMatch(/friend setup/);
  });
});
