import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "./config";
import { openDb } from "./db";
import { MIGRATIONS } from "./migrations";

const tmp = () => mkdtempSync(join(tmpdir(), "friend-test-"));
const tables = (db: ReturnType<typeof openDb>) =>
  (db.prepare("select name from sqlite_master where type='table'").all() as { name: string }[]).map((r) => r.name);

describe("openDb", () => {
  it("creates all spec tables in an empty directory", () => {
    const db = openDb(tmp());
    for (const t of ["owner", "sessions", "devices", "pair_codes", "messages", "rules", "approvals", "audit_log"]) {
      expect(tables(db)).toContain(t);
    }
  });
  it("does not re-apply migrations on a second open", () => {
    const dir = tmp();
    openDb(dir).close();
    const db = openDb(dir);
    const rows = db.prepare("select count(*) c from schema_version").get() as { c: number };
    expect(rows.c).toBe(MIGRATIONS.length);
  });
});

describe("loadConfig", () => {
  it("writes defaults on first call", () => {
    const dir = tmp();
    const cfg = loadConfig(dir);
    expect(cfg.bind).toBe("127.0.0.1");
    expect(cfg.port).toBe(8787);
    expect(cfg.trustProxy).toBe(false);
    expect(cfg.allowedOrigins).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf8")).port).toBe(8787);
  });
  it("reads edited values back and keeps unspecified defaults", () => {
    const dir = tmp();
    loadConfig(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ port: 9999, roots: ["C:/work"] }));
    const cfg = loadConfig(dir);
    expect(cfg.port).toBe(9999);
    expect(cfg.roots).toEqual(["C:/work"]);
    expect(cfg.bind).toBe("127.0.0.1");
  });
  it("has voice defaults and merges a partly edited voice section", () => {
    const dir = tmp();
    expect(loadConfig(dir).voice).toEqual({ enabled: true, sttModel: "base", ttsVoice: "en_US-lessac-medium", language: null, speakTyped: true, accept: 0.72, challenge: 0.58, hindiVoice: "hi_IN-priyamvada-medium", marathiVoice: "mr_IN-google-medium" });
    writeFileSync(join(dir, "config.json"), JSON.stringify({ voice: { sttModel: "small", language: "hi" } }));
    expect(loadConfig(dir).voice).toEqual({ enabled: true, sttModel: "small", ttsVoice: "en_US-lessac-medium", language: "hi", speakTyped: true, accept: 0.72, challenge: 0.58, hindiVoice: "hi_IN-priyamvada-medium", marathiVoice: "mr_IN-google-medium" });
  });
  it("keeps edited speaker thresholds, but falls back when they are nonsense", () => {
    const dir = tmp();
    loadConfig(dir);
    writeFileSync(join(dir, "config.json"), JSON.stringify({ voice: { accept: 0.8, challenge: 0.6 } }));
    expect(loadConfig(dir).voice).toMatchObject({ accept: 0.8, challenge: 0.6 });
    for (const bad of [{ accept: 0.5, challenge: 0.6 }, { accept: 2, challenge: 0.5 }, { accept: "high", challenge: 0.5 }, { accept: 0.7, challenge: 0.7 }]) {
      writeFileSync(join(dir, "config.json"), JSON.stringify({ voice: bad }));
      expect(loadConfig(dir).voice).toMatchObject({ accept: 0.72, challenge: 0.58 });
    }
  });
  it("includes destructive shell patterns by default", () => {
    expect(loadConfig(tmp()).destructivePatterns.length).toBeGreaterThan(5);
  });
});
