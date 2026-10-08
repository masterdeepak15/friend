import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openDb } from "../db";
import { decrypt, encrypt, loadOrCreateKey } from "./crypto";
import { FakeVoice, HttpVoiceService, fakeEmbedding } from "./service";
import { Voiceprint, centroid, checkConsistency, cosine, decideTrust } from "./voiceprint";

describe("cosine and centroid", () => {
  it("is 1 for equal directions, 0 for orthogonal and -1 for opposite", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1, 6);
    expect(cosine([1, 0], [0, 3])).toBeCloseTo(0, 6);
    expect(cosine([1, 0], [-4, 0])).toBeCloseTo(-1, 6);
  });
  it("is 0 for zero vectors and rejects mismatched lengths and non-finite numbers", () => {
    expect(cosine([0, 0], [1, 1])).toBe(0);
    expect(() => cosine([1, 2], [1, 2, 3])).toThrow(/length/i);
    expect(() => cosine([1, Number.NaN], [1, 2])).toThrow(/finite/i);
  });
  it("the centroid is the normalized mean", () => {
    const c = centroid([[1, 0], [0, 1]]);
    expect(c[0]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(c[1]).toBeCloseTo(Math.SQRT1_2, 6);
    expect(Math.hypot(...c)).toBeCloseTo(1, 6);
  });
  it("refuses an empty set or opposite vectors that cancel out", () => {
    expect(() => centroid([])).toThrow();
    expect(() => centroid([[1, 0], [-1, 0]])).toThrow(/cancel|zero/i);
  });
});

describe("decideTrust", () => {
  const t = { accept: 0.72, challenge: 0.58 };
  it.each([
    [0.95, "owner"],
    [0.72, "owner"],
    [0.7199, "challenge"],
    [0.58, "challenge"],
    [0.5799, "guest"],
    [0.1, "guest"],
    [-0.4, "guest"],
  ])("score %s is %s", (score, expected) => {
    expect(decideTrust(score, t)).toBe(expected);
  });
  it("treats a missing or non-finite score as a guest", () => {
    expect(decideTrust(Number.NaN, t)).toBe("guest");
  });
});

describe("checkConsistency", () => {
  it("accepts samples of one voice and rejects a mixed set", () => {
    const owner = [0, 1, 2, 3, 4].map((i) => fakeEmbedding("owner", `s${i}`));
    expect(checkConsistency(owner).ok).toBe(true);
    const mixed = [...owner.slice(0, 3), fakeEmbedding("stranger", "x"), fakeEmbedding("stranger", "y")];
    const r = checkConsistency(mixed);
    expect(r.ok).toBe(false);
    expect(r.min).toBeLessThan(0.55);
  });
});

describe("crypto", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "friend-crypto-"));
  it("round-trips data and the ciphertext does not contain the plaintext", () => {
    const key = loadOrCreateKey(join(dir(), "voice.key"));
    const plain = Buffer.from("a very secret voiceprint ".repeat(8));
    const blob = encrypt(key, plain);
    expect(blob.includes(Buffer.from("secret voiceprint"))).toBe(false);
    expect(decrypt(key, blob).equals(plain)).toBe(true);
  });
  it("uses a fresh nonce each time", () => {
    const key = loadOrCreateKey(join(dir(), "voice.key"));
    expect(encrypt(key, Buffer.from("same")).equals(encrypt(key, Buffer.from("same")))).toBe(false);
  });
  it("fails with the wrong key or a tampered blob instead of returning garbage", () => {
    const k1 = loadOrCreateKey(join(dir(), "a.key"));
    const k2 = loadOrCreateKey(join(dir(), "b.key"));
    const blob = encrypt(k1, Buffer.from("data"));
    expect(() => decrypt(k2, blob)).toThrow();
    const bad = Buffer.from(blob);
    bad[bad.length - 1]! ^= 1;
    expect(() => decrypt(k1, bad)).toThrow();
    expect(() => decrypt(k1, Buffer.from("short"))).toThrow();
  });
  it("creates the key once, 32 bytes, and keeps it on later loads", () => {
    const file = join(dir(), "voice.key");
    const a = loadOrCreateKey(file);
    expect(a.length).toBe(32);
    expect(existsSync(file)).toBe(true);
    expect(loadOrCreateKey(file).equals(a)).toBe(true);
    if (process.platform !== "win32") expect(statSync(file).mode & 0o077).toBe(0);
  });
  it("rejects a key file of the wrong size instead of using a weak key", () => {
    const file = join(dir(), "voice.key");
    writeFileSync(file, Buffer.alloc(5));
    expect(() => loadOrCreateKey(file)).toThrow(/invalid/i);
  });
});

describe("Voiceprint store", () => {
  let dir: string;
  let vp: Voiceprint;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "friend-vp-"));
    vp = new Voiceprint(openDb(dir), loadOrCreateKey(join(dir, "voice.key")));
  });
  const owner = (n: number) => Array.from({ length: n }, (_, i) => fakeEmbedding("owner", `s${i}`));

  it("starts empty", () => {
    expect(vp.exists()).toBe(false);
    expect(vp.info()).toBeNull();
    expect(vp.score(fakeEmbedding("owner", "x"))).toBeNull();
  });

  it("enrolls, then scores the owner high and others low", () => {
    vp.enroll(owner(5), "wespeaker");
    expect(vp.exists()).toBe(true);
    expect(vp.info()).toMatchObject({ samples: 5, model: "wespeaker" });
    expect(vp.score(fakeEmbedding("owner", "new phrase"))!).toBeGreaterThan(0.9);
    expect(vp.score(fakeEmbedding("someone-else", "x"))!).toBeLessThan(0.4);
  });

  it("stores the voiceprint encrypted: the database never holds the numbers in the clear", () => {
    vp.enroll(owner(3), "wespeaker");
    const raw = readFileSync(join(dir, "friend.db"));
    const asFloats = Buffer.from(new Float32Array(centroid(owner(3))).buffer);
    expect(raw.includes(asFloats)).toBe(false);
  });

  it("replaces an earlier voiceprint", () => {
    vp.enroll(owner(3), "wespeaker");
    vp.enroll(Array.from({ length: 3 }, (_, i) => fakeEmbedding("new-owner", `s${i}`)), "wespeaker");
    expect(vp.score(fakeEmbedding("new-owner", "x"))!).toBeGreaterThan(0.9);
    expect(vp.score(fakeEmbedding("owner", "x"))!).toBeLessThan(0.4);
  });

  it("clear() removes it", () => {
    vp.enroll(owner(3), "wespeaker");
    vp.clear();
    expect(vp.exists()).toBe(false);
  });

  it("refuses to score or load with a different key (a copied database is useless)", () => {
    vp.enroll(owner(3), "wespeaker");
    const other = new Voiceprint(openDb(dir), loadOrCreateKey(join(dir, "other.key")));
    expect(() => other.score(fakeEmbedding("owner", "x"))).toThrow();
  });

  it("rejects an embedding of the wrong size when scoring", () => {
    vp.enroll(owner(3), "wespeaker");
    expect(() => vp.score([1, 2, 3])).toThrow(/length/i);
  });

  it("rejects an empty or inconsistent enrollment set", () => {
    expect(() => vp.enroll([], "m")).toThrow();
    expect(() => vp.enroll([[1, 2], [1, 2, 3]], "m")).toThrow(/length/i);
  });
});

describe("FakeVoice speakers and the HTTP embedding API", () => {
  it("fake embeddings are deterministic, unit length, and cluster by speaker", () => {
    const a = fakeEmbedding("alice", "1");
    expect(fakeEmbedding("alice", "1")).toEqual(a);
    expect(Math.hypot(...a)).toBeCloseTo(1, 4);
    expect(cosine(a, fakeEmbedding("alice", "2"))).toBeGreaterThan(0.9);
    expect(cosine(a, fakeEmbedding("bob", "1"))).toBeLessThan(0.4);
  });

  it("FakeVoice returns scripted transcripts with the speaker's voiceprint, and enrollment embeddings", async () => {
    const v = new FakeVoice({ transcripts: [{ text: "hello", speaker: "owner" }, "plain"], enrollSpeakers: ["owner"] });
    const first = await v.transcribe(Buffer.from("a"), "audio/webm", null, { embed: true });
    expect(first.text).toBe("hello");
    expect(first.embedding).toHaveLength(256);
    const second = await v.transcribe(Buffer.from("a"), "audio/webm", null, { embed: true });
    expect(second.embedding).toBeNull(); // no speaker scripted: nothing to identify
    expect((await v.embed(Buffer.from("e"), "audio/webm")).embedding).toHaveLength(256);
    const noEmbed = await v.transcribe(Buffer.from("a"), "audio/webm");
    expect(noEmbed.embedding).toBeUndefined();
  });

  describe("HttpVoiceService", () => {
    let server: Server;
    let url = "";
    let seen: { url?: string; ctype?: string }[] = [];
    let reply: (res: import("node:http").ServerResponse) => void;
    beforeEach(async () => {
      seen = [];
      reply = (res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: "hi", language: "en", embedding: [0.6, 0.8] }));
      server = createServer((req, res) => {
        req.on("data", () => {});
        req.on("end", () => {
          seen.push({ url: req.url, ctype: req.headers["content-type"] });
          reply(res);
        });
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
      url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    });
    afterEach(async () => {
      server.closeAllConnections();
      await new Promise((r) => server.close(r));
    });
    const svc = () => new HttpVoiceService({ baseUrl: () => url, token: "t" });

    it("asks for the voiceprint in the same request and returns it", async () => {
      const out = await svc().transcribe(Buffer.from("A"), "audio/webm", "hi", { embed: true });
      expect(seen[0]!.url).toBe("/stt?language=hi&embed=1");
      expect(out).toMatchObject({ text: "hi", embedding: [0.6, 0.8] });
    });

    it("keeps the old URL when no embedding is requested", async () => {
      await svc().transcribe(Buffer.from("A"), "audio/webm");
      expect(seen[0]!.url).toBe("/stt");
    });

    it("passes on a missing voiceprint with its reason", async () => {
      reply = (res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ text: "hi", language: "en", embedding: null, embeddingError: "not enough speech" }));
      const out = await svc().transcribe(Buffer.from("A"), "audio/webm", null, { embed: true });
      expect(out.embedding).toBeNull();
      expect(out.embeddingError).toBe("not enough speech");
    });

    it("embed() posts to /embed and returns the vector and speech length", async () => {
      reply = (res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ embedding: [1, 0], seconds: 2.5 }));
      expect(await svc().embed(Buffer.from("A"), "audio/webm")).toEqual({ embedding: [1, 0], seconds: 2.5 });
      expect(seen[0]).toMatchObject({ url: "/embed", ctype: "audio/webm" });
    });

    it("embed() surfaces a safe message for too little speech", async () => {
      reply = (res) => res.writeHead(400, { "content-type": "application/json" }).end(JSON.stringify({ error: "not enough speech to recognize a voice" }));
      await expect(svc().embed(Buffer.from("A"), "audio/webm")).rejects.toThrow(/not enough speech/);
    });

    it("rejects a malformed embedding reply", async () => {
      reply = (res) => res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ embedding: "nope", seconds: 1 }));
      await expect(svc().embed(Buffer.from("A"), "audio/webm")).rejects.toThrow();
    });
  });
});
