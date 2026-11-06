import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "./app";
import { FakeProvider } from "./provider/fake";

type App = Awaited<ReturnType<typeof createApp>>;
let app: App | undefined;
afterEach(async () => {
  await app?.stop();
  app = undefined;
});

describe("every answer carries the browser protections", () => {
  it("pages, the API and errors say: no sniffing, no framing by other sites, no referrer", async () => {
    const dir = mkdtempSync(join(tmpdir(), "friend-hard-"));
    app = await createApp({ dataDir: dir, provider: new FakeProvider([]), config: { port: 0, roots: [] }, pluginCatalogDir: join(dir, "none") });
    const port = (await app.start()).port;
    for (const path of ["/", "/api/audit", "/api/does-not-exist"]) {
      const res = await fetch(`http://127.0.0.1:${port}${path}`);
      expect(res.headers.get("x-content-type-options"), path).toBe("nosniff");
      expect(res.headers.get("x-frame-options"), path).toBe("SAMEORIGIN");
      expect(res.headers.get("referrer-policy"), path).toBe("no-referrer");
      expect(res.headers.get("content-security-policy"), path).toMatch(/frame-ancestors 'self'/);
      expect(res.headers.get("content-security-policy"), path).toMatch(/object-src 'none'/);
      expect(res.headers.get("strict-transport-security"), path).toBeNull(); // plain http on this PC: HSTS only over https
    }
  });
});
