// Bundles the agent into one file, dist/agent.js, that Node runs on its own: `node agent.js`.
import { build } from "esbuild";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
spawnSync(process.execPath, [join(root, "scripts", "gen-helper.mjs")], { stdio: "inherit" });
const out = process.argv[2] ?? join(root, "dist", "agent.js");
mkdirSync(dirname(out), { recursive: true });
await build({
  entryPoints: [join(root, "src", "main.ts")],
  outfile: out,
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node24",
  external: ["bufferutil", "utf-8-validate"],
  legalComments: "none",
  logLevel: "warning",
  define: { "process.env.FRIEND_PC_AGENT_VERSION": JSON.stringify(process.env.FRIEND_PC_AGENT_VERSION ?? JSON.parse(readFileSync(join(root, "..", "friend", "package.json"), "utf8")).version) },
});
const sha = createHash("sha256").update(readFileSync(out)).digest("hex");
writeFileSync(`${out}.sha256`, sha);
console.log(`${out} ${sha}`);
