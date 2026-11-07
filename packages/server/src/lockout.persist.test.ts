import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { Audit } from "./audit";
import { Auth, LockoutError } from "./auth";
import { openDb } from "./db";
import { RateLimiter } from "./ratelimit";

const owner = { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" };

function boot(db: ReturnType<typeof openDb>, clock: () => number) {
  return new Auth(db, new Audit(db, clock), clock);
}

describe("a lockout survives a restart", () => {
  it("an address locked before the restart is still locked after it", async () => {
    let now = 1_000_000;
    const db = openDb(mkdtempSync(join(tmpdir(), "friend-lock-")));
    const a = boot(db, () => now);
    await a.setupOwner(owner);
    for (let i = 0; i < 3; i++) await a.login("wrong password", "9.9.9.9").catch(() => {});
    await expect(a.login(owner.password, "9.9.9.9")).rejects.toBeInstanceOf(LockoutError);

    const b = boot(db, () => now); // Friend restarted: a new Auth on the same database
    await expect(b.login(owner.password, "9.9.9.9")).rejects.toBeInstanceOf(LockoutError);
    expect(b.loginState("9.9.9.9").retryAfterMs).toBeGreaterThan(0);

    now += 61_000; // the wait is over
    expect((await b.login(owner.password, "9.9.9.9")).token).toBeTruthy();
  });

  it("wrong tries already made are still counted after a restart", async () => {
    const now = 1_000_000;
    const db = openDb(mkdtempSync(join(tmpdir(), "friend-lock-")));
    const a = boot(db, () => now);
    await a.setupOwner(owner);
    await a.login("wrong password", "8.8.8.8").catch(() => {});
    await a.login("wrong password", "8.8.8.8").catch(() => {});
    expect(boot(db, () => now).loginState("8.8.8.8").triesLeft).toBe(1);
  });

  it("a good sign-in clears what was saved", async () => {
    const now = 1_000_000;
    const db = openDb(mkdtempSync(join(tmpdir(), "friend-lock-")));
    const a = boot(db, () => now);
    await a.setupOwner(owner);
    await a.login("wrong password", "7.7.7.7").catch(() => {});
    await a.login(owner.password, "7.7.7.7");
    expect(boot(db, () => now).loginState("7.7.7.7").triesLeft).toBe(3);
  });

  it("the account-wide count survives too", async () => {
    const now = 1_000_000;
    const db = openDb(mkdtempSync(join(tmpdir(), "friend-lock-")));
    const a = boot(db, () => now);
    await a.setupOwner(owner);
    for (let i = 0; i < 20; i++) await a.login("wrong password", `6.6.6.${i}`).catch(() => {});
    await expect(boot(db, () => now).login(owner.password, "6.6.6.200")).rejects.toBeInstanceOf(LockoutError);
  });
});

describe("RateLimiter storage", () => {
  it("entries left alone for a day are forgotten and removed from the store", () => {
    const removed: string[] = [];
    const l = new RateLimiter(() => 100_000_000, 3, 60_000, {
      load: () => [
        { key: "old", fails: 2, lockedUntil: 0, updatedAt: 1_000 },
        { key: "fresh", fails: 2, lockedUntil: 0, updatedAt: 99_999_000 },
      ],
      save: () => {},
      remove: (k) => void removed.push(k),
    });
    expect(removed).toEqual(["old"]);
    expect(l.triesLeft("old")).toBe(3);
    expect(l.triesLeft("fresh")).toBe(1);
  });
});
