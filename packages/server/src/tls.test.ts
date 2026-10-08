import { X509Certificate } from "node:crypto";
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { ensureTlsCert, lanAddresses, tlsHosts } from "./tls";
import { FakeProvider } from "./provider/fake";

type Ifaces = Parameters<typeof lanAddresses>[0];
const nic = (...addresses: string[]): Ifaces => () => ({ eth0: addresses.map((address) => ({ address, family: "IPv4", internal: false })) as never }) as never;
const dir = () => mkdtempSync(join(tmpdir(), "friend-tls-"));

describe("the certificate for https", () => {
  it("covers this PC's names and addresses so a phone opening the address gets a matching certificate", async () => {
    const { cert } = await ensureTlsCert(dir(), ["my-pc"], nic("192.168.1.20"));
    const san = new X509Certificate(cert).subjectAltName ?? "";
    expect(san).toContain("DNS:localhost");
    expect(san).toContain("DNS:my-pc");
    expect(san).toContain("IP Address:127.0.0.1");
    expect(san).toContain("IP Address:192.168.1.20");
  });

  it("lasts as long as the record says, not the library's one-year default", async () => {
    const { cert } = await ensureTlsCert(dir(), [], nic("192.168.1.20"));
    const x = new X509Certificate(cert);
    const days = (new Date(x.validTo).getTime() - Date.now()) / (24 * 3600_000);
    expect(days).toBeGreaterThan(800);
    expect(days).toBeLessThan(826);
    expect(new Date(x.validFrom).getTime()).toBeLessThan(Date.now()); // already valid
  });

  it("is made once and kept private, then reused", async () => {
    const d = dir();
    const first = await ensureTlsCert(d, [], nic("192.168.1.20"));
    const again = await ensureTlsCert(d, [], nic("192.168.1.20"));
    expect(again.cert).toBe(first.cert);
    expect(again.key).toBe(first.key);
    if (process.platform !== "win32") expect(statSync(join(d, "tls", "key.pem")).mode & 0o077).toBe(0);
  });

  it("is made again when this PC gets a new address", async () => {
    const d = dir();
    const first = await ensureTlsCert(d, [], nic("192.168.1.20"));
    const moved = await ensureTlsCert(d, [], nic("10.0.0.7"));
    expect(moved.cert).not.toBe(first.cert);
    expect(new X509Certificate(moved.cert).subjectAltName).toContain("IP Address:10.0.0.7");
  });

  it("is made again when it is about to run out, or when its record is damaged", async () => {
    const d = dir();
    const first = await ensureTlsCert(d, [], nic("192.168.1.20"));
    const later = await ensureTlsCert(d, [], nic("192.168.1.20"), () => Date.now() + 800 * 24 * 3600_000);
    expect(later.cert).not.toBe(first.cert);
    writeFileSync(join(d, "tls", "meta.json"), "{broken");
    expect((await ensureTlsCert(d, [], nic("192.168.1.20"))).cert).not.toBe(later.cert);
  });

  it("lists each address once", () => {
    expect(tlsHosts(["LOCALHOST", "x.example"], nic("192.168.1.20", "192.168.1.20"))).toEqual(["localhost", "127.0.0.1", "::1", "192.168.1.20", "x.example"]);
  });
});

describe("serving https", () => {
  let app: Awaited<ReturnType<typeof createApp>> | null = null;
  afterEach(async () => {
    await app?.stop();
    app = null;
  });

  const get = (port: number, path: string, ca: string) =>
    new Promise<{ status: number; body: string; headers: Record<string, unknown> }>((resolve, reject) => {
      const req = request({ host: "127.0.0.1", port, path, ca, method: "GET" }, (res) => {
        let body = "";
        res.on("data", (c) => (body += c));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
      });
      req.on("error", reject);
      req.end();
    });

  it("answers over https with Friend's own certificate, and not over plain http", async () => {
    const d = dir();
    app = await createApp({ dataDir: d, provider: new FakeProvider([]), config: { port: 0, roots: [], https: true } });
    const { port } = await app.start();
    const ca = readFileSync(join(d, "tls", "cert.pem"), "utf8");
    const res = await get(port, "/api/state", ca);
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ hasOwner: false });
    await expect(fetch(`http://127.0.0.1:${port}/api/state`)).rejects.toThrow();
  });

  it("is refused by anyone who does not trust that certificate", async () => {
    app = await createApp({ dataDir: dir(), provider: new FakeProvider([]), config: { port: 0, roots: [], https: true } });
    const { port } = await app.start();
    await expect(get(port, "/api/state", "")).rejects.toThrow(/self.signed|unable to verify|certificate/i);
  });

  it("marks the sign-in cookie Secure", async () => {
    const d = dir();
    app = await createApp({ dataDir: d, provider: new FakeProvider([]), config: { port: 0, roots: [], https: true } });
    const { port } = await app.start();
    const ca = readFileSync(join(d, "tls", "cert.pem"), "utf8");
    const post = (path: string, payload: unknown) =>
      new Promise<{ status: number; cookie: string }>((resolve, reject) => {
        const data = JSON.stringify(payload);
        const req = request({ host: "127.0.0.1", port, path, ca, method: "POST", headers: { "content-type": "application/json", "content-length": Buffer.byteLength(data) } }, (res) => {
          res.resume();
          res.on("end", () => resolve({ status: res.statusCode ?? 0, cookie: String(res.headers["set-cookie"]?.[0] ?? "") }));
        });
        req.on("error", reject);
        req.end(data);
      });
    expect((await post("/api/setup", { password: "correct horse battery", pin: "123456", assistantName: "Jarvis" })).status).toBe(200);
    const login = await post("/api/login", { password: "correct horse battery" });
    expect(login.status).toBe(200);
    expect(login.cookie).toMatch(/Secure/i);
  });
});
