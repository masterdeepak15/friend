import { createServer } from "node:net";
import { findPython } from "../voice";
import type { Runner } from "../voice";

export type PrereqId = "node" | "python" | "docker" | "ollama" | "claude" | "port";

export interface Check {
  id: PrereqId;
  label: string;
  /** Without a required one Friend cannot run at all. */
  need: "required" | "optional";
  /** What it makes possible, in plain words. */
  unlocks: string;
  ok: boolean;
  detail: string;
  /** Claude Code only: installed and signed in. */
  signedIn?: boolean;
}

export interface ProbeDeps {
  run: Runner;
  fetch: typeof fetch;
  platform: NodeJS.Platform;
  nodeVersion: string;
  /** Whether nothing is listening on this port on this PC. */
  portFree: (port: number) => Promise<boolean>;
}

export function defaultPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const s = createServer();
    s.once("error", () => resolve(false));
    s.once("listening", () => s.close(() => resolve(true)));
    s.listen(port, "127.0.0.1");
  });
}

const first = (s: string) => s.trim().split(/\r?\n/)[0]?.trim() ?? "";

export async function checkNode(d: ProbeDeps): Promise<Check> {
  const major = Number(d.nodeVersion.split(".")[0]);
  const ok = major >= 20;
  return { id: "node", label: "Node.js", need: "required", unlocks: "running Friend at all", ok, detail: ok ? `Node.js ${d.nodeVersion}` : `Node.js ${d.nodeVersion}, and Friend needs version 20 or newer` };
}

export async function checkPython(d: ProbeDeps): Promise<Check> {
  const base = { id: "python" as const, label: "Python", need: "optional" as const, unlocks: "talking to Friend and hearing it (voice)" };
  const py = await findPython(d.run);
  if (!py) return { ...base, ok: false, detail: "not found (voice needs Python 3.10 or newer)" };
  const v = await d.run(py.cmd, [...py.args, "--version"]);
  return { ...base, ok: true, detail: first(v.stdout) || "Python 3.10 or newer" };
}

export async function checkDocker(d: ProbeDeps): Promise<Check> {
  const base = { id: "docker" as const, label: "Docker", need: "optional" as const, unlocks: "running code and plugin tools in a safe sandbox" };
  const v = await d.run("docker", ["--version"]);
  if (v.code !== 0) return { ...base, ok: false, detail: "not installed" };
  const info = await d.run("docker", ["info", "--format", "{{.ServerVersion}}"]);
  if (info.code !== 0) return { ...base, ok: false, detail: `${first(v.stdout)}, but it is not running. Start Docker Desktop and wait until it says it is running` };
  return { ...base, ok: true, detail: first(v.stdout) };
}

export async function checkOllama(d: ProbeDeps): Promise<Check> {
  const base = { id: "ollama" as const, label: "Ollama", need: "optional" as const, unlocks: "a free, private model that runs on this PC" };
  const v = await d.run("ollama", ["--version"]);
  let running = false;
  try {
    running = (await d.fetch("http://127.0.0.1:11434/api/version", { signal: AbortSignal.timeout(2500) })).ok;
  } catch {
    running = false;
  }
  if (v.code === 0) return { ...base, ok: true, detail: `${first(v.stdout).replace(/^.*version is /i, "Ollama ")}${running ? ", running" : ", installed (start the Ollama app if it is not running)"}` };
  if (running) return { ...base, ok: true, detail: "an Ollama server is running at 127.0.0.1:11434" };
  return { ...base, ok: false, detail: "not installed" };
}

export async function checkClaude(d: ProbeDeps, command = "claude"): Promise<Check> {
  const base = { id: "claude" as const, label: "Claude Code", need: "optional" as const, unlocks: "using your Claude subscription (no API key)" };
  const v = await d.run(command, ["--version"]);
  if (v.code !== 0) return { ...base, ok: false, detail: "not installed", signedIn: false };
  const version = first(v.stdout).replace(/\s*\(Claude Code\)\s*/i, "");
  const a = await d.run(command, ["auth", "status"]);
  let signedIn = false;
  let who = "";
  try {
    const o = JSON.parse(a.stdout) as { loggedIn?: boolean; email?: string };
    signedIn = o.loggedIn === true;
    who = typeof o.email === "string" ? o.email : "";
  } catch {
    signedIn = a.code === 0;
  }
  return { ...base, ok: true, signedIn, detail: `Claude Code ${version}, ${signedIn ? `signed in${who ? ` as ${who}` : ""}` : "not signed in yet"}` };
}

export async function checkPort(d: ProbeDeps, port: number): Promise<Check> {
  const free = await d.portFree(port);
  return { id: "port", label: `Port ${port}`, need: "optional", unlocks: "opening Friend in the browser", ok: free, detail: free ? "free" : `in use. Another program (or Friend itself) is listening there; you can pick another port below` };
}

export async function check(id: PrereqId, d: ProbeDeps, opts: { port?: number; claudeCommand?: string } = {}): Promise<Check> {
  switch (id) {
    case "node":
      return checkNode(d);
    case "python":
      return checkPython(d);
    case "docker":
      return checkDocker(d);
    case "ollama":
      return checkOllama(d);
    case "claude":
      return checkClaude(d, opts.claudeCommand);
    case "port":
      return checkPort(d, opts.port ?? 8787);
  }
}

// ---- how to install what is missing ----

export interface InstallStep {
  cmd: string;
  args: string[];
}

export interface InstallPlan {
  /** Commands run one after the other, with their output shown. Empty when it has to be done by hand. */
  steps: InstallStep[];
  /** What to do by hand when there is no command, or the tool that would do it is missing. */
  manual: string | null;
  /** True when the system will ask for an administrator password or approval. */
  asksForAdmin: boolean;
}

/** Which installers exist on this PC: package managers and npm. */
export async function installers(d: ProbeDeps): Promise<Set<string>> {
  const found = new Set<string>();
  const probes: [string, string[]][] = d.platform === "win32" ? [["winget", ["--version"]], ["npm", ["--version"]]] : d.platform === "darwin" ? [["brew", ["--version"]], ["npm", ["--version"]]] : [["apt-get", ["--version"]], ["npm", ["--version"]]];
  for (const [cmd, args] of probes) if ((await d.run(cmd, args)).code === 0) found.add(cmd);
  return found;
}

const manual = (text: string): InstallPlan => ({ steps: [], manual: text, asksForAdmin: false });

export function installPlan(id: PrereqId, platform: NodeJS.Platform, have: Set<string>): InstallPlan | null {
  const winget = (pkg: string): InstallPlan => ({ steps: [{ cmd: "winget", args: ["install", "-e", "--id", pkg, "--accept-package-agreements", "--accept-source-agreements"] }], manual: null, asksForAdmin: true });
  switch (id) {
    case "node":
      return manual("Install Node.js 20 or newer from https://nodejs.org, then open a new terminal and run: friend onboard");
    case "port":
      return null;
    case "claude":
      return have.has("npm") ? { steps: [{ cmd: "npm", args: ["install", "-g", "@anthropic-ai/claude-code"] }], manual: null, asksForAdmin: false } : manual("Install Claude Code from https://claude.com/claude-code");
    case "python":
      if (platform === "win32") return have.has("winget") ? winget("Python.Python.3.12") : manual("Install Python 3.12 from https://www.python.org/downloads/ (tick \"Add python.exe to PATH\")");
      if (platform === "darwin") return have.has("brew") ? { steps: [{ cmd: "brew", args: ["install", "python@3.12"] }], manual: null, asksForAdmin: false } : manual("Install Python 3.12 from https://www.python.org/downloads/");
      return have.has("apt-get") ? { steps: [{ cmd: "sudo", args: ["apt-get", "install", "-y", "python3", "python3-venv", "python3-pip"] }], manual: null, asksForAdmin: true } : manual("Install Python 3.10 or newer with your package manager (and its venv package)");
    case "docker":
      if (platform === "win32") return have.has("winget") ? winget("Docker.DockerDesktop") : manual("Install Docker Desktop from https://www.docker.com/products/docker-desktop/");
      if (platform === "darwin") return have.has("brew") ? { steps: [{ cmd: "brew", args: ["install", "--cask", "docker"] }], manual: null, asksForAdmin: true } : manual("Install Docker Desktop from https://www.docker.com/products/docker-desktop/");
      return manual("Install Docker Engine: https://docs.docker.com/engine/install/ (then add your user to the docker group)");
    case "ollama":
      if (platform === "win32") return have.has("winget") ? winget("Ollama.Ollama") : manual("Install Ollama from https://ollama.com/download");
      if (platform === "darwin") return have.has("brew") ? { steps: [{ cmd: "brew", args: ["install", "ollama"] }], manual: null, asksForAdmin: false } : manual("Install Ollama from https://ollama.com/download");
      return manual("Install Ollama: open https://ollama.com/download and run the command shown there for Linux");
  }
}
