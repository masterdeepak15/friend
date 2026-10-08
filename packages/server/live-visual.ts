import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { systemInfo } from "../agent-cli/src/tools/system";
import { createApp } from "./src/app";
import { DEFAULT_OLLAMA } from "./src/config";
import { OllamaProvider } from "./src/provider/ollama";
import type { Provider, StreamRequest } from "./src/provider/types";

const real = new OllamaProvider({ ...DEFAULT_OLLAMA });
let calls = 0;
const t0 = Date.now();
const spy: Provider = {
  id: "spy",
  async *stream(req: StreamRequest) {
    calls++;
    const started = Date.now();
    console.log(`[model call ${calls}] ${req.messages.length} messages, last role ${req.messages.at(-1)?.role}`);
    for await (const ev of real.stream(req)) {
      if (ev.type === "tool_call") console.log("  TOOL CALL:", ev.name, JSON.stringify(ev.args).slice(0, 120));
      yield ev;
    }
    console.log(`  (took ${Math.round((Date.now() - started) / 1000)} s)`);
  },
};

const app = await createApp({ dataDir: mkdtempSync(join(tmpdir(), "friend-livevis-")), provider: spy, config: { port: 0, roots: [] } });
await app.auth.setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Jarvis" });
// a stand-in device that answers system.info with the real numbers of this PC
(app.devices as unknown as { hasOnline: () => boolean; exec: (...a: unknown[]) => Promise<unknown>; targetName: () => string }).hasOnline = () => true;
(app.devices as unknown as { exec: (name: string) => Promise<unknown> }).exec = async (name: string) => (name === "system.info" ? systemInfo() : { ok: false, error: "not available in this test" });

const out: string[] = [];
await app.agent.runTurn("Show me the weather in Pune and also my computer stats on the screen.", {
  trust: "owner",
  ip: "127.0.0.1",
  emit: (m) => {
    if (m.type === "caption.delta") out.push(m.text);
    if (m.type === "approval.request") console.log("  APPROVAL ASKED:", m.summary.slice(0, 100));
  },
});
console.log("\nREPLY:", out.join("").trim());
console.log("SCREEN:", JSON.stringify(app.stage.snapshot().objects.map((o) => `${o.id}(${o.type})`)));
console.log("TOTAL SECONDS:", Math.round((Date.now() - t0) / 1000), "model calls:", calls);
await app.stop();
