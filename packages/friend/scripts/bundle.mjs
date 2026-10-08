// Builds the npm package: one program (dist/friend.mjs) plus the files it needs next to it.
// Run `pnpm build` first (it builds the web app), or use `pnpm package` from the repository root.
import { build } from "esbuild";
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const pkgDir = resolve(here, "..");
const repo = resolve(pkgDir, "../..");
const dist = join(pkgDir, "dist");
const pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8"));

const web = join(repo, "packages/web/dist");
if (!existsSync(join(web, "index.html"))) {
  console.error("The web app is not built yet. Run `pnpm build` first (or `pnpm package` from the repository root).");
  process.exit(1);
}

rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });

// Everything of ours is bundled into one file; the packages from npm stay packages (they are this package's dependencies).
await build({
  entryPoints: [join(repo, "packages/agent-cli/src/bin.ts")],
  outfile: join(dist, "friend.mjs"),
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  external: Object.keys(pkg.dependencies),
  banner: { js: "import { createRequire as __friendCreateRequire } from 'node:module'; const require = __friendCreateRequire(import.meta.url);" },
  define: { __FRIEND_VERSION__: JSON.stringify(pkg.version) },
  legalComments: "none",
  logLevel: "info",
});

const keep = (src) => !/(^|[\\/])(__pycache__|node_modules|\.venv|\.pytest_cache)([\\/]|$)|\.pyc$/.test(src);
cpSync(web, join(dist, "web"), { recursive: true });
cpSync(join(repo, "plugins"), join(dist, "plugins"), { recursive: true, filter: keep });
cpSync(join(repo, "packages/voice/friend_voice"), join(dist, "voice/friend_voice"), { recursive: true, filter: keep });
cpSync(join(repo, "README.md"), join(pkgDir, "README.md"));
writeFileSync(join(dist, "BUILD.json"), JSON.stringify({ name: pkg.name, version: pkg.version, builtAt: new Date().toISOString() }, null, 2));
console.log(`Built ${pkg.name} ${pkg.version} in ${dist}`);
