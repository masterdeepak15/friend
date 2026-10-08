import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { McpHub } from "./hub";
import { ConnectorStore } from "./store";

/** Talks to the real chrome-control-mcp installed on this PC. Run with FRIEND_LIVE_CHROME=1. */
const live = process.env.FRIEND_LIVE_CHROME === "1" ? describe : describe.skip;

live("the real chrome-control connector", () => {
  it("connects and lists its tools", async () => {
    const hub = new McpHub(new ConnectorStore(mkdtempSync(join(tmpdir(), "friend-live-chrome-"))), { connectTimeoutMs: 40_000 });
    try {
      const v = await hub.add({ id: "chrome", name: "Chrome control", kind: "stdio", command: "chrome-control-mcp", args: [] });
      console.log("status", v.status, v.error, "tools", v.tools, hub.toolSpecs().map((t) => t.name).join(","));
      expect(v.status).toBe("ready");
      expect(v.tools).toBeGreaterThan(10);
      const status = hub.toolSpecs().find((t) => t.name.endsWith(".status"));
      if (status) console.log("status tool:", (await hub.call(status.name, {})).text.slice(0, 300));
    } finally {
      await hub.close();
    }
  }, 60_000);
});
