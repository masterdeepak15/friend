// Builds the program that runs inside the sandbox process (src/sandbox/child.ts) into .sandbox-dev/child.mjs, for running from the
// source tree and for the tests. The packaged build does the same into dist/sandbox-child.mjs (packages/friend/scripts/bundle.mjs).
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const server = resolve(here, "..");
// esbuild lives in the packaging project
const { build } = createRequire(join(server, "..", "friend", "package.json"))("esbuild");

await build({
  entryPoints: [join(server, "src/sandbox/child.ts")],
  outfile: join(server, ".sandbox-dev/child.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: ["quickjs-emscripten", "pyodide", "just-bash"],
  legalComments: "none",
  logLevel: "warning",
});
