import { loadConfig, saveConfig } from "@friend/server";
import type { IO } from "../cli";
import { defaultRunner, type Runner } from "./voice";

export interface OllamaDeps {
  fetch?: typeof fetch;
  run?: Runner;
  /** How long to wait for a freshly started Ollama to answer. */
  waitMs?: number;
  pollMs?: number;
}

const CONTAINER = "friend-ollama";

async function serverVersion(f: typeof fetch, url: string): Promise<string | null> {
  try {
    const res = await f(`${url}/api/version`, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return ((await res.json()) as { version?: string }).version ?? "unknown";
  } catch {
    return null;
  }
}

async function installedModels(f: typeof fetch, url: string): Promise<string[]> {
  try {
    const res = await f(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
    if (!res.ok) return [];
    return ((await res.json()) as { models?: { name: string }[] }).models?.map((m) => m.name) ?? [];
  } catch {
    return [];
  }
}

const hasModel = (models: string[], wanted: string) => models.includes(wanted) || (!wanted.includes(":") && models.includes(`${wanted}:latest`));

/** True for the address a Docker container started by this command would serve. */
function isDefaultLocal(url: string): boolean {
  try {
    const u = new URL(url);
    return (u.hostname === "127.0.0.1" || u.hostname === "localhost") && (u.port === "11434" || u.port === "");
  } catch {
    return false;
  }
}

async function statusCommand(io: IO, f: typeof fetch): Promise<number> {
  const cfg = loadConfig(io.dataDir);
  io.out(`Provider:       ${cfg.provider}`);
  const version = await serverVersion(f, cfg.ollama.url);
  if (!version) {
    io.out(`Ollama:         not reachable at ${cfg.ollama.url}. Run: friend ollama setup`);
    return 0;
  }
  io.out(`Ollama:         running (${version}) at ${cfg.ollama.url}`);
  const models = await installedModels(f, cfg.ollama.url);
  io.out(`Models:         ${models.length ? models.join(", ") : "(none)"}`);
  io.out(`Configured:     ${cfg.ollama.model} ${hasModel(models, cfg.ollama.model) ? "(installed)" : "(not installed). Run: friend ollama setup"}`);
  return 0;
}

async function startServer(io: IO, url: string, run: Runner, waitMs: number, pollMs: number, f: typeof fetch): Promise<boolean> {
  if (!isDefaultLocal(url)) {
    io.err(`Ollama is not reachable at ${url}. Start it yourself, then run this again.`);
    return false;
  }
  if ((await run("docker", ["--version"])).code !== 0) {
    io.err("Ollama is not running and Docker was not found. Install Ollama from https://ollama.com (or Docker Desktop) and run this again.");
    return false;
  }
  io.out("Starting Ollama in Docker…");
  let r = await run("docker", ["start", CONTAINER]);
  if (r.code !== 0) {
    r = await run("docker", ["run", "-d", "--name", CONTAINER, "-v", "friend-ollama:/root/.ollama", "-p", "11434:11434", "ollama/ollama"]);
    if (r.code !== 0) {
      io.err(`Could not start Ollama in Docker.\n${r.stdout.trim().split(/\r?\n/).slice(-6).join("\n")}`);
      return false;
    }
  }
  const t0 = Date.now();
  while (Date.now() - t0 < waitMs) {
    if (await serverVersion(f, url)) return true;
    await new Promise((res) => setTimeout(res, pollMs));
  }
  io.err("Ollama did not answer in time. Check: docker logs friend-ollama");
  return false;
}

async function pull(io: IO, f: typeof fetch, url: string, model: string): Promise<boolean> {
  io.out(`Downloading ${model} (this can take a while)…`);
  let res: Response;
  try {
    res = await f(`${url}/api/pull`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ model, stream: true }) });
  } catch {
    io.err("Lost the connection to Ollama.");
    return false;
  }
  if (!res.ok || !res.body) {
    io.err(`Ollama refused the download (${res.status}).`);
    return false;
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let lastStatus = "";
  let lastPct = -10;
  const handle = (line: string): boolean => {
    if (!line.trim()) return true;
    let o: { status?: string; total?: number; completed?: number; error?: string };
    try {
      o = JSON.parse(line);
    } catch {
      return true;
    }
    if (o.error) {
      io.err(`Download failed: ${o.error}`);
      return false;
    }
    const pct = o.total ? Math.floor(((o.completed ?? 0) / o.total) * 100) : null;
    if (o.status && o.status !== lastStatus) {
      lastStatus = o.status;
      lastPct = -10;
      io.out(`  ${o.status}`);
    }
    if (pct !== null && pct >= lastPct + 10) {
      lastPct = pct;
      io.out(`  ${pct}%`);
    }
    return true;
  };
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let nl: number;
    while ((nl = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, nl);
      buffer = buffer.slice(nl + 1);
      if (!handle(line)) return false;
    }
  }
  return handle(buffer);
}

async function setupCommand(args: string[], io: IO, deps: Required<OllamaDeps>): Promise<number> {
  const cfg = loadConfig(io.dataDir);
  const url = cfg.ollama.url;
  const use = args.includes("--use");
  const model = args.find((a) => !a.startsWith("--")) ?? cfg.ollama.model;

  if (!(await serverVersion(deps.fetch, url))) {
    if (!(await startServer(io, url, deps.run, deps.waitMs, deps.pollMs, deps.fetch))) return 1;
  }

  if (hasModel(await installedModels(deps.fetch, url), model)) {
    io.out(`${model} is already installed.`);
  } else if (!(await pull(io, deps.fetch, url, model))) {
    return 1;
  }

  const next = loadConfig(io.dataDir);
  next.ollama.model = model;
  if (use) next.provider = "ollama";
  saveConfig(next);

  io.out(use ? `Friend now answers with ${model} through Ollama.` : `Use it with: friend config set provider ollama`);
  io.out("Note: without a GPU a 7B model answers slowly (a few words per second). Smaller models such as llama3.2:3b are faster but use tools less reliably.");
  return 0;
}

export async function ollamaCommand(args: string[], io: IO, deps: OllamaDeps = {}): Promise<number> {
  const full: Required<OllamaDeps> = {
    fetch: deps.fetch ?? fetch,
    run: deps.run ?? defaultRunner,
    waitMs: deps.waitMs ?? 60_000,
    pollMs: deps.pollMs ?? 1000,
  };
  switch (args[0]) {
    case "status":
      return statusCommand(io, full.fetch);
    case "setup":
      return setupCommand(args.slice(1), io, full);
    default:
      io.err("Usage: friend ollama status | friend ollama setup [model] [--use]");
      return 1;
  }
}
