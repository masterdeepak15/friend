import { mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { IO } from "./cli";
import { capture, interactive } from "./commands/onboard/exec";
import { check, defaultPortFree, installPlan, type ProbeDeps } from "./commands/onboard/prereq";
import { emptyState, loadState, resetState, saveState, statePath } from "./commands/onboard/state";
import { choose, chooseMany, text, yesNo, type Option, type Ui } from "./commands/onboard/ui";

function ui(answers: string[], yes = false): { ui: Ui; out: string[]; asked: string[] } {
  const out: string[] = [];
  const asked: string[] = [];
  const io: IO = { dataDir: "x", out: (s) => out.push(s), err: (s) => out.push(s), ask: async (q) => (asked.push(q), answers.shift() ?? "") };
  return { ui: { io, yes }, out, asked };
}
const opts: Option[] = [
  { key: "a", label: "Alpha" },
  { key: "b", label: "Beta", hint: "second" },
  { key: "c", label: "Gamma" },
];

describe("choose", () => {
  it("takes a number, a name, or the suggestion on Enter, and marks the suggestion", async () => {
    const t = ui(["2"]);
    expect(await choose(t.ui, "Pick", opts, "a")).toBe("b");
    expect(t.out.join("\n")).toMatch(/1\) Alpha.*<- suggested/);
    expect(t.out.join("\n")).toMatch(/2\) Beta {2}\(second\)/);
    expect(await choose(ui(["GAMMA"]).ui, "Pick", opts, "a")).toBe("c");
    expect(await choose(ui([""]).ui, "Pick", opts, "b")).toBe("b");
  });
  it("asks again after something that is not a choice, then takes the suggestion", async () => {
    const t = ui(["9", "zzz", "0"]);
    expect(await choose(t.ui, "Pick", opts, "c")).toBe("c");
    expect(t.out.join("\n").match(/is not one of the choices/g)).toHaveLength(3);
    expect(t.out.join("\n")).toMatch(/Taking the suggested choice: Gamma/);
  });
  it("with --yes asks nothing", async () => {
    const t = ui([], true);
    expect(await choose(t.ui, "Pick", opts, "b")).toBe("b");
    expect(t.asked).toEqual([]);
  });
});

describe("chooseMany", () => {
  it("takes numbers or names, in list order without repeats", async () => {
    expect(await chooseMany(ui(["3, 1,1"]).ui, "Pick", opts, [])).toEqual(["a", "c"]);
    expect(await chooseMany(ui(["beta gamma"]).ui, "Pick", opts, [])).toEqual(["b", "c"]);
  });
  it("understands all, none and Enter", async () => {
    expect(await chooseMany(ui(["all"]).ui, "Pick", opts, [])).toEqual(["a", "b", "c"]);
    expect(await chooseMany(ui(["none"]).ui, "Pick", opts, ["a"])).toEqual([]);
    expect(await chooseMany(ui([""]).ui, "Pick", opts, ["b"])).toEqual(["b"]);
  });
  it("shows the suggestions in the prompt and asks again after a bad one", async () => {
    const t = ui(["1,9", "2"]);
    expect(await chooseMany(t.ui, "Pick", opts, ["a", "c"])).toEqual(["b"]);
    expect(t.asked[0]).toContain("[1,3]");
    expect(t.out.join("\n")).toMatch(/"9" is not one of the choices/);
  });
  it("with --yes returns the suggestions without asking", async () => {
    const t = ui([], true);
    expect(await chooseMany(t.ui, "Pick", opts, ["c"])).toEqual(["c"]);
    expect(t.asked).toEqual([]);
  });
});

describe("yesNo and text", () => {
  it("understands yes, no and Enter", async () => {
    expect(await yesNo(ui(["y"]).ui, "Q", false)).toBe(true);
    expect(await yesNo(ui(["YES"]).ui, "Q", false)).toBe(true);
    expect(await yesNo(ui(["n"]).ui, "Q", true)).toBe(false);
    expect(await yesNo(ui([""]).ui, "Q", true)).toBe(true);
    expect(await yesNo(ui([""]).ui, "Q", false)).toBe(false);
  });
  it("shows the suggestion as the capital letter, asks again for nonsense, then takes it", async () => {
    const t = ui(["maybe", "perhaps", "what"]);
    expect(await yesNo(t.ui, "Q", true)).toBe(true);
    expect(t.asked[0]).toContain("[Y/n]");
    expect(t.out.join("\n").match(/Please answer y or n/g)).toHaveLength(3);
    expect(ui([]).asked).toEqual([]);
  });
  it("text takes what is typed or the suggestion", async () => {
    expect(await text(ui(["  hello "]).ui, "Name", "x")).toBe("hello");
    expect(await text(ui([""]).ui, "Name", "x")).toBe("x");
    expect(await text(ui([], true).ui, "Name", "x")).toBe("x");
  });
});

describe("the progress file", () => {
  const dir = () => mkdtempSync(join(tmpdir(), "friend-state-"));
  it("round-trips, and reset removes it", () => {
    const d = dir();
    const s = emptyState();
    s.done.welcome = "2026-10-08T00:00:00Z";
    s.features = ["voice", "ollama"];
    s.restart = ["python"];
    saveState(d, s);
    expect(loadState(d)).toEqual(s);
    resetState(d);
    expect(loadState(d)).toEqual(emptyState());
  });
  it("ignores garbage in it", () => {
    const d = dir();
    writeFileSync(statePath(d), JSON.stringify({ version: 1, done: { a: "x", b: 5 }, features: ["voice", "teleport", 3], restart: ["x", 4] }));
    expect(loadState(d)).toEqual({ version: 1, done: { a: "x" }, features: ["voice"], restart: ["x"] });
    writeFileSync(statePath(d), "[1,2");
    expect(loadState(d)).toEqual(emptyState());
    writeFileSync(statePath(d), "null");
    expect(loadState(d)).toEqual(emptyState());
  });
});

describe("install plans", () => {
  const have = (...x: string[]) => new Set(x);
  const cmd = (p: ReturnType<typeof installPlan>) => p?.steps.map((s) => [s.cmd, ...s.args].join(" ")) ?? [];

  it("Windows uses winget with the right package and agreements, and says it may ask for approval", () => {
    expect(cmd(installPlan("python", "win32", have("winget")))).toEqual(["winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements"]);
    expect(cmd(installPlan("docker", "win32", have("winget")))[0]).toContain("Docker.DockerDesktop");
    expect(cmd(installPlan("ollama", "win32", have("winget")))[0]).toContain("Ollama.Ollama");
    expect(installPlan("python", "win32", have("winget"))!.asksForAdmin).toBe(true);
  });
  it("macOS uses Homebrew", () => {
    expect(cmd(installPlan("python", "darwin", have("brew")))).toEqual(["brew install python@3.12"]);
    expect(cmd(installPlan("docker", "darwin", have("brew")))).toEqual(["brew install --cask docker"]);
    expect(cmd(installPlan("ollama", "darwin", have("brew")))).toEqual(["brew install ollama"]);
  });
  it("Linux uses apt for Python and gives links for the rest", () => {
    expect(cmd(installPlan("python", "linux", have("apt-get")))).toEqual(["sudo apt-get install -y python3 python3-venv python3-pip"]);
    expect(installPlan("docker", "linux", have("apt-get"))!.manual).toMatch(/docs\.docker\.com/);
    expect(installPlan("ollama", "linux", have("apt-get"))!.manual).toMatch(/ollama\.com\/download/);
  });
  it("Claude Code is installed with npm on every system, and by hand when npm is missing", () => {
    for (const p of ["win32", "darwin", "linux"] as const) expect(cmd(installPlan("claude", p, have("npm")))).toEqual(["npm install -g @anthropic-ai/claude-code"]);
    expect(installPlan("claude", "win32", have())!.manual).toMatch(/claude\.com/);
  });
  it("falls back to a link when the system's installer is missing", () => {
    expect(installPlan("python", "win32", have())!.steps).toEqual([]);
    expect(installPlan("python", "win32", have())!.manual).toMatch(/python\.org/);
    expect(installPlan("docker", "darwin", have())!.manual).toMatch(/docker\.com/);
  });
  it("Node.js is never installed by the wizard (it is the thing running), and the port has no fix", () => {
    expect(installPlan("node", "win32", have("winget"))!.steps).toEqual([]);
    expect(installPlan("node", "win32", have("winget"))!.manual).toMatch(/nodejs\.org/);
    expect(installPlan("port", "win32", have())).toBeNull();
  });
  it("never builds a command from anything typed by the person", () => {
    for (const id of ["python", "docker", "ollama", "claude"] as const) for (const p of ["win32", "darwin", "linux"] as const) for (const s of installPlan(id, p, have("winget", "brew", "apt-get", "npm"))!.steps) for (const part of [s.cmd, ...s.args]) expect(part).toMatch(/^[A-Za-z0-9@._\-/:=]+$/);
  });
});

describe("the checks", () => {
  const miss = { code: 127, stdout: "" };
  const base = (run: ProbeDeps["run"], over: Partial<ProbeDeps> = {}): ProbeDeps => ({ run, fetch: (async () => ({ ok: false })) as unknown as typeof fetch, platform: "linux", nodeVersion: "22.0.0", portFree: async () => true, ...over });

  it("Node: 20 and up passes, 19 and down does not", async () => {
    expect((await check("node", base(async () => miss, { nodeVersion: "20.0.0" }))).ok).toBe(true);
    expect((await check("node", base(async () => miss, { nodeVersion: "19.9.0" }))).ok).toBe(false);
    expect((await check("node", base(async () => miss, { nodeVersion: "24.1.0" }))).need).toBe("required");
  });
  it("Python: a version below 3.10 does not count", async () => {
    expect((await check("python", base(async () => ({ code: 0, stdout: "Python 3.9.18" })))).ok).toBe(false);
    expect((await check("python", base(async () => ({ code: 0, stdout: "Python 3.12.1" })))).detail).toBe("Python 3.12.1");
  });
  it("Python: the Windows Store stub that prints a message and fails does not count", async () => {
    expect((await check("python", base(async () => ({ code: 9009, stdout: "Python was not found; run without arguments to install from the Microsoft Store" })))).ok).toBe(false);
  });
  it("Ollama: a server that answers counts even without the command", async () => {
    const r = await check("ollama", base(async () => miss, { fetch: (async () => ({ ok: true })) as unknown as typeof fetch }));
    expect(r.ok).toBe(true);
    expect(r.detail).toMatch(/running at 127\.0\.0\.1:11434/);
  });
  it("Claude Code: not signed in is reported separately, and bad output is not trusted", async () => {
    const out = await check("claude", base(async (_c, a) => (a[0] === "--version" ? { code: 0, stdout: "2.1.1 (Claude Code)" } : { code: 1, stdout: JSON.stringify({ loggedIn: false }) })));
    expect(out).toMatchObject({ ok: true, signedIn: false });
    expect(out.detail).toMatch(/not signed in yet/);
    const odd = await check("claude", base(async (_c, a) => (a[0] === "--version" ? { code: 0, stdout: "2.1.1" } : { code: 1, stdout: "garbage" })));
    expect(odd.signedIn).toBe(false);
  });
  it("Docker: installed but not running is not ready, and says how to start it", async () => {
    const r = await check("docker", base(async (_c, a) => (a[0] === "--version" ? { code: 0, stdout: "Docker version 27" } : { code: 1, stdout: "" })));
    expect(r.ok).toBe(false);
    expect(r.detail).toMatch(/Start Docker Desktop/);
  });
  it("the port: free or taken", async () => {
    expect((await check("port", base(async () => miss), { port: 8787 })).ok).toBe(true);
    expect((await check("port", base(async () => miss, { portFree: async () => false }), { port: 9000 })).detail).toMatch(/in use/);
  });
});

describe("running real commands", () => {
  it("capture reports the output and the exit code, and 127 for a program that is not there", async () => {
    const ok = await capture(process.execPath, ["-e", "console.log('hi'); console.error('err')"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toMatch(/hi/);
    expect(ok.stdout).toMatch(/err/);
    expect((await capture(process.execPath, ["-e", "process.exit(3)"])).code).toBe(3);
    expect((await capture("definitely-not-a-real-program-xyz", [])).code).toBe(127);
  });
  it("capture streams lines when asked", async () => {
    const lines: string[] = [];
    await capture(process.execPath, ["-e", "console.log('one'); console.log('two')"], { onLine: (l) => lines.push(l) });
    expect(lines).toEqual(["one", "two"]);
  });
  it("interactive returns the exit code, and 127 for a program that is not there", async () => {
    expect(await interactive(process.execPath, ["-e", "process.exit(0)"])).toBe(0);
    expect(await interactive(process.execPath, ["-e", "process.exit(5)"])).toBe(5);
    expect(await interactive("definitely-not-a-real-program-xyz", [])).toBe(127);
  });
  it("defaultPortFree sees a port that is in use", async () => {
    const s = createServer();
    await new Promise<void>((r) => s.listen(0, "127.0.0.1", r));
    const port = (s.address() as { port: number }).port;
    expect(await defaultPortFree(port)).toBe(false);
    await new Promise((r) => s.close(r));
    expect(await defaultPortFree(port)).toBe(true);
  });
});
