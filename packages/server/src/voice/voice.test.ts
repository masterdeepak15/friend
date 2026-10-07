import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { FakeVoice, HttpVoiceService } from "./service";
import { SidecarProcess } from "./sidecar";

let fake: Server;
let port = 0;
let seen: { method?: string; url?: string; headers: IncomingMessage["headers"]; body: Buffer }[] = [];
let handler: (req: IncomingMessage, res: ServerResponse, body: Buffer) => void;

beforeEach(async () => {
  seen = [];
  handler = (_req, res) => {
    res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ ok: true }));
  };
  fake = createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on("data", (d) => parts.push(d));
    req.on("end", () => {
      const body = Buffer.concat(parts);
      seen.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  port = (fake.address() as { port: number }).port;
});
afterEach(async () => {
  fake.closeAllConnections();
  await new Promise((r) => fake.close(r));
});

const service = (opts: { timeoutMs?: number; base?: () => string | null } = {}) =>
  new HttpVoiceService({ baseUrl: opts.base ?? (() => `http://127.0.0.1:${port}`), token: "secret-1", timeoutMs: opts.timeoutMs ?? 3000 });

describe("HttpVoiceService", () => {
  it("transcribes: posts the audio with the secret and content type, maps the JSON reply", async () => {
    handler = (_q, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: " hello there ", language: "en", duration: 1.2 }));
    const out = await service().transcribe(Buffer.from("AUDIO"), "audio/webm;codecs=opus");
    expect(out).toEqual({ text: "hello there", language: "en" });
    expect(seen[0]).toMatchObject({ method: "POST", url: "/stt" });
    expect(seen[0]!.headers.authorization).toBe("Bearer secret-1");
    expect(seen[0]!.headers["content-type"]).toBe("audio/webm;codecs=opus");
    expect(seen[0]!.body.toString()).toBe("AUDIO");
  });

  it("passes a language hint as a query parameter", async () => {
    handler = (_q, res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: "x", language: "hi", duration: 1 }));
    await service().transcribe(Buffer.from("A"), "audio/webm", "hi");
    expect(seen[0]!.url).toBe("/stt?language=hi");
  });

  it("synthesizes: posts JSON and returns the WAV bytes", async () => {
    handler = (_q, res) => res.writeHead(200, { "content-type": "audio/wav" }).end(Buffer.from("RIFFxxxx"));
    const wav = await service().synthesize("Good evening", "en_US-lessac-medium");
    expect(wav.toString()).toBe("RIFFxxxx");
    expect(seen[0]).toMatchObject({ method: "POST", url: "/tts" });
    expect(JSON.parse(seen[0]!.body.toString())).toEqual({ text: "Good evening", voice: "en_US-lessac-medium" });
  });

  it("rejects with the sidecar's error message on a non-200 reply", async () => {
    handler = (_q, res) => res.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: "model exploded" }));
    await expect(service().transcribe(Buffer.from("A"), "audio/webm")).rejects.toThrow(/model exploded/);
    handler = (_q, res) => res.writeHead(401).end("{}");
    await expect(service().synthesize("x")).rejects.toThrow(/401/);
  });

  it("rejects when the sidecar never answers", async () => {
    handler = () => {};
    await expect(service({ timeoutMs: 150 }).transcribe(Buffer.from("A"), "audio/webm")).rejects.toThrow(/timed out/i);
  });

  it("rejects clearly when the sidecar is not running", async () => {
    await expect(service({ base: () => null }).synthesize("x")).rejects.toThrow(/not running/i);
    expect(service({ base: () => null }).available()).toBe(false);
  });

  it("is available when it has a base URL and health answers", async () => {
    const s = service();
    expect(s.available()).toBe(true);
    expect(await s.check()).toBe(true);
    expect(seen[0]).toMatchObject({ method: "GET", url: "/health" });
    fake.closeAllConnections();
    await new Promise((r) => fake.close(r));
    expect(await s.check()).toBe(false);
    expect(s.available()).toBe(false);
    fake = createServer(); // so afterEach can close something
    await new Promise<void>((r) => fake.listen(0, "127.0.0.1", () => r()));
  });
});

describe("FakeVoice", () => {
  it("returns scripted transcripts in order and records synthesis requests", async () => {
    const v = new FakeVoice({ transcripts: ["one", "two"] });
    expect((await v.transcribe(Buffer.from("a"), "audio/webm")).text).toBe("one");
    expect((await v.transcribe(Buffer.from("b"), "audio/webm")).text).toBe("two");
    expect((await v.synthesize("hi there")).subarray(0, 4).toString()).toBe("RIFF");
    expect(v.synthesized).toEqual(["hi there"]);
    expect(v.transcribed).toHaveLength(2);
  });
  it("can be unavailable and can be told to fail", async () => {
    const v = new FakeVoice({ available: false, failTranscribe: true });
    expect(v.available()).toBe(false);
    await expect(v.transcribe(Buffer.from("a"), "audio/webm")).rejects.toThrow();
  });
});

describe("SidecarProcess", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "friend-sidecar-"));

  /** A stand-in for the Python sidecar: a Node script that answers /health and prints the ready line. */
  function script(opts: { crashOnceFile?: string; alwaysCrash?: boolean; neverReady?: boolean } = {}): { command: string; args: string[] } {
    const code = `
      const http = require("http"); const fs = require("fs");
      const crashOnce = ${JSON.stringify(opts.crashOnceFile ?? "")};
      if (${opts.alwaysCrash ? "true" : "false"} || (crashOnce && !fs.existsSync(crashOnce))) {
        if (crashOnce) fs.writeFileSync(crashOnce, "x");
        setTimeout(() => process.exit(3), 100);
      } else {
        const s = http.createServer((q, r) => r.end("{}"));
        s.listen(0, "127.0.0.1", () => { ${opts.neverReady ? "" : `console.log(JSON.stringify({ ready: true, port: s.address().port }));`} });
        process.stdin.resume(); process.stdin.on("end", () => process.exit(0));
      }`;
    const file = join(dir(), "fake-sidecar.cjs");
    writeFileSync(file, code);
    return { command: process.execPath, args: [file] };
  }

  const live: SidecarProcess[] = [];
  afterEach(async () => {
    for (const p of live.splice(0)) await p.stop();
  });
  const start = async (extra: Parameters<typeof script>[0] = {}, opts: Partial<ConstructorParameters<typeof SidecarProcess>[0]> = {}) => {
    const p = new SidecarProcess({ ...script(extra), token: "tok", readyTimeoutMs: 5000, restartDelayMs: 50, ...opts });
    live.push(p);
    await p.start();
    return p;
  };

  it("starts the process, reads the ready line and exposes the base URL", async () => {
    const p = await start();
    expect(p.running()).toBe(true);
    expect(p.baseUrl()).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
  });

  it("stops the process by closing its stdin", async () => {
    const p = await start();
    await p.stop();
    expect(p.running()).toBe(false);
    expect(p.baseUrl()).toBeNull();
  });

  it("restarts once after a crash and serves from the new port", async () => {
    const marker = join(dir(), "crashed-once");
    const p = new SidecarProcess({ ...script({ crashOnceFile: marker }), token: "tok", readyTimeoutMs: 5000, restartDelayMs: 50 });
    live.push(p);
    // the first run crashes before printing a ready line, so start() reports it and the supervisor restarts it
    await p.start().catch(() => {});
    const t0 = Date.now();
    while (!p.running() && Date.now() - t0 < 5000) await new Promise((r) => setTimeout(r, 50));
    expect(existsSync(marker)).toBe(true);
    expect(p.running()).toBe(true);
    expect(p.restarts()).toBe(1);
  });

  it("gives up after the allowed restarts instead of looping forever", async () => {
    const p = new SidecarProcess({ ...script({ alwaysCrash: true }), token: "tok", readyTimeoutMs: 3000, restartDelayMs: 30, maxRestarts: 1 });
    live.push(p);
    await p.start().catch(() => {});
    await new Promise((r) => setTimeout(r, 800));
    expect(p.running()).toBe(false);
    expect(p.restarts()).toBe(1);
  });

  it("reports a readable error when the command does not exist", async () => {
    const p = new SidecarProcess({ command: join(dir(), "no-such-python"), args: [], token: "t", readyTimeoutMs: 2000 });
    live.push(p);
    await expect(p.start()).rejects.toThrow(/could not start|ENOENT/i);
    expect(p.running()).toBe(false);
  });

  it("times out when the sidecar never becomes ready", async () => {
    const p = new SidecarProcess({ ...script({ neverReady: true }), token: "t", readyTimeoutMs: 400 });
    live.push(p);
    await expect(p.start()).rejects.toThrow(/did not become ready/i);
  });
});
