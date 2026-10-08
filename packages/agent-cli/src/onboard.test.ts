import { Audit, Auth, loadConfig, openDb } from "@friend/server";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { IO } from "./cli";
import { doctorCommand } from "./commands/doctor";
import { STEP_IDS, onboardCommand, type OnboardDeps } from "./commands/onboard";
import { loadState, statePath } from "./commands/onboard/state";

let dataDir: string;
let lines: string[];
let asked: string[];
const text = () => lines.join("\n");

/** A pretend PC: what is installed, what installing does, and a record of everything the wizard ran. */
function world(over: Partial<{ python: boolean; docker: boolean; dockerRunning: boolean; ollama: boolean; ollamaRunning: boolean; claude: boolean; signedIn: boolean; winget: boolean; npm: boolean; brew: boolean; apt: boolean; portFree: boolean; node: string; platform: NodeJS.Platform; installWorks: boolean; visibleAfterInstall: boolean }> = {}) {
  const have = { python: true, docker: true, dockerRunning: true, ollama: true, ollamaRunning: true, claude: true, signedIn: true, winget: true, npm: true, brew: false, apt: false, portFree: true, node: "22.3.0", platform: "win32" as NodeJS.Platform, installWorks: true, visibleAfterInstall: true, ...over };
  const ran: string[] = [];
  const interactiveRan: string[] = [];
  const opened: string[] = [];
  const calls = { start: 0, voiceSetup: [] as string[][], ollamaSetup: [] as string[][] };
  const miss = { code: 127, stdout: "not found" };
  const deps: OnboardDeps = {
    platform: have.platform,
    nodeVersion: have.node,
    portFree: async () => have.portFree,
    fetch: (async () => ({ ok: have.ollamaRunning })) as unknown as typeof fetch,
    run: async (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      ran.push(line);
      if (cmd === "python") return have.python ? { code: 0, stdout: "Python 3.12.4" } : miss;
      if (cmd === "docker") return args[0] === "--version" ? (have.docker ? { code: 0, stdout: "Docker version 27.1.1, build abc" } : miss) : have.docker && have.dockerRunning ? { code: 0, stdout: "27.1.1" } : { code: 1, stdout: "error during connect" };
      if (cmd === "ollama") return have.ollama ? { code: 0, stdout: "ollama version is 0.5.1" } : miss;
      if (cmd === "claude") {
        if (!have.claude) return miss;
        if (args[0] === "--version") return { code: 0, stdout: "2.1.294 (Claude Code)" };
        return have.signedIn ? { code: 0, stdout: JSON.stringify({ loggedIn: true, email: "me@example.com" }) } : { code: 1, stdout: JSON.stringify({ loggedIn: false }) };
      }
      if (cmd === "winget") return have.winget ? { code: 0, stdout: "v1.8" } : miss;
      if (cmd === "brew") return have.brew ? { code: 0, stdout: "Homebrew 4" } : miss;
      if (cmd === "apt-get") return have.apt ? { code: 0, stdout: "apt 2.7" } : miss;
      if (cmd === "npm") return have.npm ? { code: 0, stdout: "10.8.0" } : miss;
      return miss;
    },
    interactive: async (cmd, args) => {
      const line = [cmd, ...args].join(" ");
      interactiveRan.push(line);
      if (!have.installWorks && cmd !== "claude") return 1;
      if (/Python\.Python|python@3|python3/.test(line)) have.python = have.visibleAfterInstall;
      if (/Docker\.DockerDesktop|cask docker/.test(line)) have.docker = have.visibleAfterInstall;
      if (/Ollama\.Ollama|install ollama/.test(line)) have.ollama = have.visibleAfterInstall;
      if (/@anthropic-ai\/claude-code/.test(line)) have.claude = have.visibleAfterInstall;
      if (cmd === "claude" && args[0] === "auth" && args[1] === "login") have.signedIn = true;
      return 0;
    },
    openUrl: async (u) => void opened.push(u),
    start: async () => (calls.start++, 0),
    voiceSetup: async (_io, args) => (calls.voiceSetup.push(args), 0),
    ollamaSetup: async (_io, args) => (calls.ollamaSetup.push(args), 0),
  };
  return { have, deps, ran, interactiveRan, opened, calls };
}

function makeIo(answers: string[], extra: Partial<IO> = {}): IO {
  return {
    dataDir,
    out: (s) => lines.push(s),
    err: (s) => lines.push(s),
    ask: async (q) => {
      asked.push(q);
      return answers.shift() ?? "";
    },
    ...extra,
  };
}
const hasOwner = () => {
  const db = openDb(dataDir);
  try {
    return new Auth(db, new Audit(db)).hasOwner();
  } finally {
    db.close();
  }
};

/** The answers of a whole run in which every choice is the suggested one (Enter), except the account and "do not start". */
const ENTER_ALL = (name = "Jarvis") => [
  "", // ready to begin
  "", // features: the suggested ones
  "correct horse battery", "correct horse battery", "123456", "123456", name, // account
  "", // claude model
  "", // set up voice now
  "", // workspace
  "", "", // network: this PC only, port
  "", // look
  "n", // start now
];

beforeEach(() => {
  dataDir = mkdtempSync(join(tmpdir(), "friend-onboard-"));
  lines = [];
  asked = [];
});
afterEach(() => vi.useRealTimers());

describe("a PC that has everything", () => {
  it("walks through every step with the suggestions and ends with a working set-up", async () => {
    const w = world();
    expect(await onboardCommand([], makeIo(ENTER_ALL()), w.deps)).toBe(0);
    const out = text();
    for (const t of ["Welcome", "What you want to use", "What this PC needs", "Your account", "How Friend thinks", "Voice", "Your workspace folder", "Who can open Friend", "How it looks", "Finish"]) expect(out, t).toContain(t);
    expect(out).toMatch(/Step 1 of 10/);
    expect(out).toMatch(/Step 10 of 10/);
    expect(out).toMatch(/✓ Node\.js\s+Node\.js 22\.3\.0/);
    expect(out).toMatch(/✓ Claude Code\s+Claude Code 2\.1\.294, signed in as me@example\.com/);
    expect(out).toMatch(/✓ Python\s+Python 3\.12\.4/);
    expect(hasOwner()).toBe(true);
    const cfg = loadConfig(dataDir);
    expect(cfg).toMatchObject({ provider: "claude-code", bind: "127.0.0.1", port: 8787 });
    expect(cfg.claudeCode).toMatchObject({ model: "sonnet", fallback: "none" });
    expect(cfg.look).toMatchObject({ style: "sphere", accent: "#3fd8ff" });
    expect(w.calls.voiceSetup).toEqual([[]]); // the voice step hands over to the voice setup, which asks female or male
    expect(w.interactiveRan).toEqual([]); // nothing needed installing
    expect(w.calls.start).toBe(0);
    expect(out).toMatch(/Assistant:\s+Jarvis/);
    expect(out).toMatch(/Thinks with: Claude \(sonnet\), your subscription/);
    expect(Object.keys(loadState(dataDir).done)).toEqual(STEP_IDS);
  });

  it("asks nothing it does not need to: a handful of questions with secrets hidden", async () => {
    const w = world();
    await onboardCommand([], makeIo(ENTER_ALL()), w.deps);
    expect(asked).toHaveLength(ENTER_ALL().length);
    expect(asked.some((q) => /password/i.test(q))).toBe(true);
  });

  it("starts Friend and opens the browser when asked to", async () => {
    vi.useFakeTimers();
    const w = world();
    const answers = ENTER_ALL();
    answers[answers.length - 1] = ""; // start now: yes
    answers.push(""); // open the browser: yes
    await onboardCommand([], makeIo(answers), w.deps);
    expect(w.calls.start).toBe(1);
    expect(text()).toMatch(/Starting Friend\. Press Ctrl\+C/);
    await vi.advanceTimersByTimeAsync(3000);
    expect(w.opened).toEqual(["http://127.0.0.1:8787"]);
  });

  it("does not open the browser if the owner says no", async () => {
    vi.useFakeTimers();
    const w = world();
    const answers = ENTER_ALL();
    answers[answers.length - 1] = "";
    answers.push("n");
    await onboardCommand([], makeIo(answers), w.deps);
    await vi.advanceTimersByTimeAsync(5000);
    expect(w.opened).toEqual([]);
  });
});

describe("what this PC needs", () => {
  it("stops with a clear message when Node.js is too old", async () => {
    const w = world({ node: "18.19.0" });
    expect(await onboardCommand([], makeIo(["", ""]), w.deps)).toBe(1);
    expect(text()).toMatch(/Node\.js 18\.19\.0, and Friend needs version 20 or newer/);
    expect(text()).toMatch(/nodejs\.org/);
    expect(hasOwner()).toBe(false);
  });

  it("checks only what the chosen features need", async () => {
    const w = world();
    await onboardCommand([], makeIo(["", "3", ...Array(30).fill("")]), w.deps);
    expect(text()).toMatch(/[✓·✗] Ollama/);
    expect(text()).not.toMatch(/[✓·✗] Docker/);
    expect(text()).not.toMatch(/[✓·✗] Python/);
    expect(w.ran.some((l) => l.startsWith("docker"))).toBe(false);
    expect(w.ran.some((l) => l.startsWith("claude"))).toBe(false);
  });

  it("offers to install what is missing, one by one, showing the exact command, and checks again afterwards", async () => {
    const w = world({ python: false, docker: false });
    // features 1,4,5; install Python: yes; install Docker: no; then the rest with the suggestions
    const answers = ["", "1,4,5", "", "n"];
    await onboardCommand([], makeIo(answers), w.deps);
    const out = text();
    expect(out).toMatch(/Python: not found \(voice needs Python 3\.10 or newer\)/);
    expect(out).toMatch(/winget install -e --id Python\.Python\.3\.12/);
    expect(asked.find((q) => /Install Python now/.test(q))).toBeTruthy();
    expect(asked.find((q) => /Install Docker now/.test(q))).toBeTruthy();
    expect(w.interactiveRan).toEqual(["winget install -e --id Python.Python.3.12 --accept-package-agreements --accept-source-agreements"]);
    expect(out).toMatch(/✓ Python 3\.12\.4/);
    expect(out).toMatch(/Skipped\. You can install it yourself later/);
    expect(out.indexOf("Install Python")).toBeLessThan(out.indexOf("Docker: not installed"));
  });

  it("explains an install that fails, and does not pretend", async () => {
    const w = world({ python: false, installWorks: false });
    await onboardCommand([], makeIo(["", "1,4", ""]), w.deps);
    expect(text()).toMatch(/That did not work \(exit code 1\)/);
    expect(text()).toMatch(/install Python by hand/);
    expect(w.have.python).toBe(false);
  });

  it("when an install worked but this terminal cannot see it yet, says to open a new one, and remembers", async () => {
    const w = world({ python: false, visibleAfterInstall: false });
    await onboardCommand([], makeIo(["", "1,4", "", "n"]), w.deps);
    expect(text()).toMatch(/was installed, but this terminal cannot see it yet/);
    expect(loadState(dataDir).restart).toEqual(["python"]);
    expect(asked.some((q) => /Carry on with the other steps now/.test(q))).toBe(true);
    // answering no stops here; nothing later happened
    expect(hasOwner()).toBe(false);
    expect(loadState(dataDir).done.prereqs).toBeUndefined();
  });

  it("--no-install never installs anything, and says what to do by hand", async () => {
    const w = world({ python: false, docker: false });
    await onboardCommand(["--no-install"], makeIo(["", "1,4,5", ...Array(20).fill("")]), w.deps);
    expect(w.interactiveRan).toEqual([]);
    expect(asked.some((q) => /Install .* now/.test(q))).toBe(false);
    expect(text()).toMatch(/Python is needed for talking to Friend/);
  });

  it("uses the right installer for the system: Homebrew on a Mac, apt on Linux, a plain link when there is none", async () => {
    const mac = world({ platform: "darwin", python: false, brew: true, winget: false });
    await onboardCommand([], makeIo(["", "1,4", "", ...Array(20).fill("")]), mac.deps);
    expect(mac.interactiveRan).toEqual(["brew install python@3.12"]);

    lines = [];
    dataDir = mkdtempSync(join(tmpdir(), "friend-onboard-"));
    const linux = world({ platform: "linux", python: false, apt: true, winget: false });
    await onboardCommand([], makeIo(["", "1,4", "", ...Array(20).fill("")]), linux.deps);
    expect(linux.interactiveRan).toEqual(["sudo apt-get install -y python3 python3-venv python3-pip"]);
    expect(text()).toMatch(/administrator password/);

    lines = [];
    dataDir = mkdtempSync(join(tmpdir(), "friend-onboard-"));
    const bare = world({ python: false, winget: false });
    await onboardCommand([], makeIo(["", "1,4", "n", ...Array(20).fill("")]), bare.deps);
    expect(bare.interactiveRan).toEqual([]);
    expect(text()).toMatch(/python\.org\/downloads/);
  });

  it("installs Claude Code with npm, and only when npm exists", async () => {
    const w = world({ claude: false });
    await onboardCommand([], makeIo(["", "1", "", ...Array(30).fill("")]), w.deps);
    expect(w.interactiveRan[0]).toBe("npm install -g @anthropic-ai/claude-code");
    cleanup2();
    const noNpm = world({ claude: false, npm: false });
    await onboardCommand([], makeIo(["", "1", "", ...Array(30).fill("")]), noNpm.deps);
    expect(noNpm.interactiveRan).toEqual([]);
    expect(text()).toMatch(/claude\.com\/claude-code/);
  });

  it("warns when the port is taken and asks for another", async () => {
    const w = world({ portFree: false });
    const answers = ENTER_ALL();
    answers[answers.length - 3] = "9100"; // network: this PC only (Enter), then the port
    await onboardCommand([], makeIo(answers), w.deps);
    expect(text()).toMatch(/Port 8787\s+in use/);
    expect(text()).toMatch(/Port 8787 is already in use/);
    expect(loadConfig(dataDir).port).toBe(9100);
  });

  it("tells a Docker that is installed but not running how to start it", async () => {
    const w = world({ dockerRunning: false });
    await onboardCommand([], makeIo(["", "1,5", ...Array(30).fill("")]), w.deps);
    expect(text()).toMatch(/Docker version 27\.1\.1.*but it is not running\. Start Docker Desktop/);
  });
});

function cleanup2() {
  lines = [];
  dataDir = mkdtempSync(join(tmpdir(), "friend-onboard-"));
}

describe("the account", () => {
  const run = (w: ReturnType<typeof world>, answers: string[]) => onboardCommand([], makeIo(answers), w.deps);
  const head = ["", "1"]; // begin, Claude only

  it("asks twice for the password and the PIN, and tries again when they do not match", async () => {
    const w = world();
    // the password is typed twice wrongly then rightly; the PIN wrongly then rightly: only the part that failed is asked again
    await run(w, [...head, "correct horse battery", "something else", "correct horse battery", "correct horse battery", "123456", "654321", "123456", "123456", "Jarvis", ...Array(30).fill("")]);
    expect(text()).toMatch(/Those two did not match/);
    expect(text()).toMatch(/The PINs did not match/);
    expect(hasOwner()).toBe(true);
  });

  it("explains a PIN that is too short and asks again", async () => {
    const w = world();
    await run(w, [...head, "correct horse battery", "correct horse battery", "123", "123", "", "correct horse battery", "correct horse battery", "123456", "123456", "Jarvis", ...Array(30).fill("")]);
    expect(text()).toMatch(/PIN must be at least 6 digits/i);
    expect(hasOwner()).toBe(true);
  });

  it("gives up after three tries, says how to carry on, and asks again next time", async () => {
    const w = world();
    await run(w, [...head, ...Array(18).fill("a"), ...Array(30).fill("")]);
    expect(hasOwner()).toBe(false);
    expect(text()).toMatch(/could not create the account/i);
    expect(loadState(dataDir).done.account).toBeUndefined();
  });

  it("leaves an existing account alone", async () => {
    const db = openDb(dataDir);
    await new Auth(db, new Audit(db)).setupOwner({ password: "correct horse battery", pin: "123456", assistantName: "Existing" });
    db.close();
    const w = world();
    await run(w, [...head, ...Array(30).fill("")]);
    expect(text()).toMatch(/already an owner account \(Existing\)/);
    expect(asked.some((q) => /password/i.test(q))).toBe(false);
  });
});

describe("how Friend thinks", () => {
  const run = (w: ReturnType<typeof world>, features: string, rest: string[]) => onboardCommand([], makeIo(["", features, "correct horse battery", "correct horse battery", "123456", "123456", "", ...rest, ...Array(30).fill("")]), w.deps);

  it("signs in to Claude when Claude Code is installed but nobody is signed in", async () => {
    const w = world({ signedIn: false });
    await run(w, "1", ["", ""]); // sign in: yes; model: suggested
    expect(w.interactiveRan).toContain("claude auth login");
    expect(loadConfig(dataDir).provider).toBe("claude-code");
    expect(text()).toMatch(/signed in as me@example\.com/);
  });

  it("keeps going, and says what to do, when the person does not sign in", async () => {
    const w = world({ signedIn: false });
    await run(w, "1", ["n"]);
    expect(w.interactiveRan).not.toContain("claude auth login");
    expect(text()).toMatch(/Not signed in yet/);
    expect(text()).toMatch(/No model is ready yet/);
    expect(loadState(dataDir).done.model).toBeUndefined();
  });

  it("lets the person choose the Claude model", async () => {
    const w = world();
    await run(w, "1", ["2"]);
    expect(loadConfig(dataDir).claudeCode.model).toBe("haiku");
  });

  it("saves an API key without showing it and picks the Claude API", async () => {
    const w = world();
    await run(w, "2", ["sk-ant-test-key-123"]);
    const cfg = loadConfig(dataDir);
    expect(cfg).toMatchObject({ provider: "claude", apiKey: "sk-ant-test-key-123" });
    expect(text()).not.toContain("sk-ant-test-key-123");
    expect(text()).toMatch(/Claude with your API key/);
  });

  it("an empty API key means later, and no model is ready", async () => {
    const w = world();
    await run(w, "2", [""]);
    expect(loadConfig(dataDir).apiKey).toBeNull();
    expect(text()).toMatch(/friend config set apiKey/);
  });

  it("sets up the local model with Ollama, or skips the big download", async () => {
    const w = world();
    await run(w, "3", [""]); // download: yes
    expect(w.calls.ollamaSetup).toEqual([["setup"]]);
    expect(loadConfig(dataDir).provider).toBe("ollama");
    cleanup2();
    const skip = world();
    await run(skip, "3", ["n"]);
    expect(skip.calls.ollamaSetup).toEqual([]);
    expect(loadConfig(dataDir).provider).toBe("ollama");
    expect(text()).toMatch(/friend ollama setup/);
  });

  it("puts the local model behind Claude as a safety net when both are chosen", async () => {
    const w = world();
    await run(w, "1,3", ["", "n"]);
    const cfg = loadConfig(dataDir);
    expect(cfg.provider).toBe("claude-code");
    expect(cfg.claudeCode.fallback).toBe("ollama");
    expect(text()).toMatch(/local model as a safety net/);
  });

  it("falls back to the API key when Claude Code is missing", async () => {
    const w = world({ claude: false, winget: true, npm: false });
    await run(w, "1,2", ["sk-ant-x"]);
    expect(loadConfig(dataDir).provider).toBe("claude");
  });
});

describe("voice", () => {
  const rest = (voiceAnswer: string[]) => onboardCommand([], makeIo(["", "1,4", "correct horse battery", "correct horse battery", "123456", "123456", "", "", ...voiceAnswer, ...Array(30).fill("")]), undefined as never);

  it("hands over to the voice setup (which asks female or male), unless declined", async () => {
    const w = world();
    await onboardCommand([], makeIo(["", "1,4", "correct horse battery", "correct horse battery", "123456", "123456", "", "", "n", "female", ...Array(30).fill("")]), w.deps);
    expect(w.calls.voiceSetup).toEqual([]);
    expect(loadConfig(dataDir).voice.ttsVoice).toBe("en_US-amy-medium");
    expect(text()).toMatch(/Run `friend voice setup` when you want to finish it/);
    expect(loadState(dataDir).done.voice).toBeUndefined();
    void rest;
  });

  it("can pick a male voice for later, or leave it", async () => {
    const w = world();
    await onboardCommand([], makeIo(["", "1,4", "correct horse battery", "correct horse battery", "123456", "123456", "", "", "n", "male", ...Array(30).fill("")]), w.deps);
    expect(loadConfig(dataDir).voice.ttsVoice).toBe("en_US-ryan-medium");
    cleanup2();
    await onboardCommand([], makeIo(["", "1,4", "correct horse battery", "correct horse battery", "123456", "123456", "", "", "n", "3", ...Array(30).fill("")]), world().deps);
    expect(loadConfig(dataDir).voice.ttsVoice).toBe("en_US-lessac-medium");
  });

  it("says to install Python first when it is missing, and is skipped entirely when voice was not chosen", async () => {
    const w = world({ python: false });
    await onboardCommand(["--no-install"], makeIo(["", "1,4", "correct horse battery", "correct horse battery", "123456", "123456", "", "", ...Array(30).fill("")]), w.deps);
    expect(text()).toMatch(/Voice needs Python 3\.10 or newer/);
    expect(w.calls.voiceSetup).toEqual([]);
    cleanup2();
    const none = world();
    await onboardCommand([], makeIo(["", "1", "correct horse battery", "correct horse battery", "123456", "123456", "", "", ...Array(30).fill("")]), none.deps);
    expect(text()).toMatch(/You did not choose voice, so I am skipping it/);
    expect(none.calls.voiceSetup).toEqual([]);
  });
});

describe("workspace, network and look", () => {
  const upTo = ["", "1", "correct horse battery", "correct horse battery", "123456", "123456", "", ""]; // through the account and model

  it("creates the workspace folder and uses it", async () => {
    const dir = join(tmpdir(), `friend-ws-${Date.now()}`);
    await onboardCommand([], makeIo([...upTo, dir, ...Array(30).fill("")]), world().deps);
    expect(loadConfig(dataDir).roots).toEqual([dir.replace(/\//g, "\\").length ? loadConfig(dataDir).roots[0] : dir]);
    expect(existsSync(loadConfig(dataDir).roots[0]!)).toBe(true);
    expect(text()).toMatch(/Workspace: /);
  });

  it("opens Friend to the network on a chosen port with a secure address, so a phone can use the microphone", async () => {
    await onboardCommand([], makeIo([...upTo, "", "2", "9100", "", ...Array(30).fill("")]), world().deps);
    const cfg = loadConfig(dataDir);
    expect([cfg.bind, cfg.port, cfg.https]).toEqual(["0.0.0.0", 9100, true]);
    expect(asked.some((q) => /secure \(https\) address so a phone can use the microphone/.test(q))).toBe(true);
    expect(text()).toMatch(/Friend will be at https:\/\/127\.0\.0\.1:9100/);
    expect(text()).not.toMatch(/microphone and camera only work on this PC/);
  });

  it("keeps plain http when the owner declines the secure address, and warns about the microphone", async () => {
    await onboardCommand([], makeIo([...upTo, "", "2", "9100", "n", ...Array(30).fill("")]), world().deps);
    const cfg = loadConfig(dataDir);
    expect([cfg.bind, cfg.port, cfg.https]).toEqual(["0.0.0.0", 9100, false]);
    expect(text()).toMatch(/Friend will be at http:\/\/127\.0\.0\.1:9100/);
    expect(text()).toMatch(/microphone and camera only work on this PC/);
  });

  it("does not ask about https when only this PC can open Friend", async () => {
    await onboardCommand([], makeIo([...upTo, "", "", "", ...Array(30).fill("")]), world().deps);
    expect(loadConfig(dataDir).https).toBe(false);
    expect(asked.some((q) => /secure \(https\)/.test(q))).toBe(false);
  });

  it("asks again for a port that makes no sense", async () => {
    await onboardCommand([], makeIo([...upTo, "", "", "80", "abc", "9200", ...Array(30).fill("")]), world().deps);
    expect(text().match(/must be a whole number from 1024 to 65535/g)).toHaveLength(2);
    expect(loadConfig(dataDir).port).toBe(9200);
  });

  it("applies the chosen look", async () => {
    await onboardCommand([], makeIo([...upTo, "", "", "", "3", ...Array(30).fill("")]), world().deps);
    expect(loadConfig(dataDir).look).toMatchObject({ style: "orb", accent: "#ff9b3d", intensity: 0.7 });
    expect(text()).toMatch(/Look: Ember/);
  });
});

describe("carrying on later", () => {
  it("remembers finished steps and does not ask for them again", async () => {
    const w = world({ python: false, visibleAfterInstall: false });
    await onboardCommand([], makeIo(["", "1,4", "", "n"]), w.deps); // stops at the restart question
    expect(loadState(dataDir).done).toMatchObject({ welcome: expect.any(String), features: expect.any(String) });
    lines = [];
    asked = [];
    const again = world(); // now Python is visible
    await onboardCommand([], makeIo([...Array(40).fill("")].map((_, i) => ["correct horse battery", "correct horse battery", "123456", "123456", "Jarvis"][i] ?? "")), again.deps);
    expect(text()).toMatch(/✓ Welcome \(done earlier\)/);
    expect(text()).toMatch(/✓ What you want to use \(done earlier\)/);
    expect(asked.some((q) => /Ready to begin/.test(q))).toBe(false);
    expect(hasOwner()).toBe(true);
  });

  it("--reset starts from the beginning", async () => {
    await onboardCommand([], makeIo(ENTER_ALL()), world().deps);
    expect(existsSync(statePath(dataDir))).toBe(true);
    lines = [];
    await onboardCommand(["--reset"], makeIo(["n"]), world().deps);
    expect(asked.some((q) => /Ready to begin/.test(q))).toBe(true);
    expect(text()).not.toMatch(/done earlier/);
  });

  it("--redo runs one step again", async () => {
    await onboardCommand([], makeIo(ENTER_ALL()), world().deps);
    lines = [];
    asked = [];
    await onboardCommand(["--redo", "look"], makeIo(["5", "n"]), world().deps);
    expect(asked.some((q) => /Choose 1-7/.test(q))).toBe(true);
    expect(loadConfig(dataDir).look.accent).toBe("#3dff8c");
    expect(text()).toMatch(/✓ Your account \(done earlier\)/);
  });

  it("redoing the choice of features starts the dependent steps again", async () => {
    await onboardCommand([], makeIo(ENTER_ALL()), world().deps);
    await onboardCommand(["--redo", "features"], makeIo(["3", ...Array(30).fill("")]), world().deps);
    const done = loadState(dataDir).done;
    expect(loadState(dataDir).features).toEqual(["ollama"]);
    expect(done.model).toBeTruthy();
  });

  it("refuses a step that does not exist", async () => {
    expect(await onboardCommand(["--redo", "nonsense"], makeIo([]), world().deps)).toBe(1);
    expect(text()).toMatch(/There is no step "nonsense".*welcome/);
  });

  it("a damaged progress file just means starting again", async () => {
    writeFileSync(statePath(dataDir), "{nonsense");
    expect(await onboardCommand([], makeIo(["n"]), world().deps)).toBe(0);
    expect(asked.some((q) => /Ready to begin/.test(q))).toBe(true);
  });
});

describe("with no terminal", () => {
  it("refuses to ask questions into the void", async () => {
    expect(await onboardCommand([], makeIo([], { interactive: false }), world().deps)).toBe(1);
    expect(text()).toMatch(/needs a terminal/);
  });

  it("--yes takes every suggestion, but still has to ask for the secrets", async () => {
    const w = world();
    expect(await onboardCommand(["--yes"], makeIo(["correct horse battery", "correct horse battery", "123456", "123456", "sk-unused"], { interactive: false }), w.deps)).toBe(0);
    expect(hasOwner()).toBe(true);
    expect(loadConfig(dataDir).provider).toBe("claude-code");
    expect(asked.every((q) => /password|PIN|again/i.test(q))).toBe(true);
    expect(w.calls.start).toBe(1); // "start now" is a suggestion too
  });
});

describe("friend doctor", () => {
  it("lists everything it checks, and how to fix what is missing, without changing anything", async () => {
    const w = world({ python: false, claude: false, docker: false });
    expect(await doctorCommand(makeIo([]), w.deps)).toBe(0);
    const out = text();
    expect(out).toMatch(/✓ Node\.js/);
    expect(out).toMatch(/· Python\s+not found/);
    expect(out).toMatch(/needed for talking to Friend and hearing it \(voice\)\. To fix: winget install -e --id Python\.Python\.3\.12/);
    expect(out).toMatch(/· Claude Code\s+not installed/);
    expect(out).toMatch(/npm install -g @anthropic-ai\/claude-code/);
    expect(out).toMatch(/friend onboard/);
    expect(w.interactiveRan).toEqual([]);
  });

  it("says to sign in to Claude Code when it is installed but signed out", async () => {
    const w = world({ signedIn: false });
    await doctorCommand(makeIo([]), w.deps);
    expect(text()).toMatch(/sign in with: claude auth login/);
  });

  it("fails (exit code 1) only when something required is missing", async () => {
    expect(await doctorCommand(makeIo([]), world({ node: "16.0.0" }).deps)).toBe(1);
    expect(await doctorCommand(makeIo([]), world({ python: false, docker: false, ollama: false, claude: false }).deps)).toBe(0);
  });

  it("shows the saved settings it reads", async () => {
    await doctorCommand(makeIo([]), world().deps);
    expect(text()).toMatch(/Model: claude\s+Address: 127\.0\.0\.1:8787/);
  });
});

describe("the progress file", () => {
  it("holds nothing secret", async () => {
    await onboardCommand([], makeIo(ENTER_ALL()), world().deps);
    const raw = readFileSync(statePath(dataDir), "utf8");
    expect(raw).not.toMatch(/correct horse|123456|sk-/);
  });
});
