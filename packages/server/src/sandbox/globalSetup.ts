import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// The sandbox tests run the real sandbox program, so it is built once before the tests start.
export default function setup(): void {
  const server = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
  execFileSync(process.execPath, [join(server, "scripts", "build-sandbox.mjs")], { stdio: "inherit" });
}
