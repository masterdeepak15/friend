import { THEMES, resolveVoice, voiceLabel } from "@friend/protocol";
import { Audit, Auth, loadConfig, openDb, saveConfig, type Config } from "@friend/server";
import crossSpawn from "cross-spawn";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { IO } from "../../cli";
import { urlsFor } from "../lan";
import { ollamaCommand } from "../ollama";
import { startCommand } from "../start";
import { voiceSetupCommand, type Runner } from "../voice";
import { capture, interactive, type Interactive } from "./exec";
import { check, defaultPortFree, installPlan, installers, type Check, type PrereqId, type ProbeDeps } from "./prereq";
import { loadState, resetState, saveState, type Feature, type OnboardState } from "./state";
import { choose, chooseMany, heading, text, yesNo, type Ui } from "./ui";

export interface OnboardDeps extends ProbeDeps {
  run: Runner;
  interactive: Interactive;
  openUrl: (url: string) => Promise<void>;
  /** Runs Friend until it is stopped. */
  start: (io: IO) => Promise<number>;
  voiceSetup: (io: IO, args: string[]) => Promise<number>;
  ollamaSetup: (io: IO, args: string[]) => Promise<number>;
}

export function defaultOnboardDeps(): OnboardDeps {
  return {
    run: capture,
    interactive,
    fetch,
    platform: process.platform,
    nodeVersion: process.versions.node,
    portFree: defaultPortFree,
    openUrl: async (url) => {
      const [cmd, args] = process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : process.platform === "darwin" ? ["open", [url]] : ["xdg-open", [url]];
      try {
        crossSpawn(cmd as string, args as string[], { stdio: "ignore", detached: true }).unref();
      } catch {
        /* the address is printed anyway */
      }
    },
    start: startCommand,
    voiceSetup: (io, args) => voiceSetupCommand(io, { run: capture }, args),
    ollamaSetup: (io, args) => ollamaCommand(args, io, { run: capture }),
  };
}

type Result = "done" | "later" | "stop";

interface Ctx {
  io: IO;
  ui: Ui;
  deps: OnboardDeps;
  state: OnboardState;
  flags: { noInstall: boolean };
  /** Exit code when a step stops the wizard. */
  exit: number;
  /** The result of the last prerequisite check, by id. */
  checks: Map<PrereqId, Check>;
}

const FEATURE_PREREQ: Partial<Record<Feature, PrereqId>> = { "claude-code": "claude", ollama: "ollama", voice: "python", sandbox: "docker" };

const has = (c: Ctx, f: Feature) => c.state.features.includes(f);
const save = (c: Ctx) => saveState(c.io.dataDir, c.state);

// ───────────────────────── steps ─────────────────────────

async function welcome(c: Ctx): Promise<Result> {
  const { io } = c;
  io.out("Welcome. This sets Friend up on this PC, one step at a time.");
  io.out("Every step explains what it does, and you can press Enter to take the suggestion.");
  io.out("Nothing is installed or downloaded without asking you first, and you can stop any time:");
  io.out("run `friend onboard` again and it carries on where it stopped.");
  if (!(await yesNo(c.ui, "Ready to begin?", true))) {
    io.out("No problem. Run `friend onboard` whenever you are ready.");
    return "stop";
  }
  return "done";
}

async function features(c: Ctx): Promise<Result> {
  c.io.out("What do you want Friend to use? Pick any; I will check what each one needs next.");
  let picked: Feature[] = [];
  for (let t = 0; t < 3; t++) {
    picked = await chooseMany<Feature>(
      c.ui,
      "",
      [
        { key: "claude-code", label: "Claude, through your Claude subscription", hint: "uses the Claude Code app, no API key" },
        { key: "claude-api", label: "Claude, with an API key", hint: "pay per use" },
        { key: "ollama", label: "A model on this PC with Ollama", hint: "free and private, but slower" },
        { key: "voice", label: "Voice: talk to Friend and hear it", hint: "needs Python, about 250 MB" },
        { key: "sandbox", label: "Safe code running and plugin tools", hint: "needs Docker" },
      ],
      ["claude-code", "voice"],
    );
    if (picked.some((f) => f === "claude-code" || f === "claude-api" || f === "ollama")) break;
    c.io.out("Friend needs at least one way to think: choose Claude (1 or 2) or a model on this PC (3).");
    picked = [];
  }
  if (picked.length === 0) picked = ["claude-code"];
  c.state.features = picked;
  save(c);
  return "done";
}

async function fixOne(c: Ctx, id: PrereqId, ch: Check): Promise<Check> {
  const { io, deps } = c;
  const probe = (): Promise<Check> => check(id, deps, { port: loadConfig(io.dataDir).port, claudeCommand: loadConfig(io.dataDir).claudeCode.command });
  const plan = installPlan(id, deps.platform, await installers(deps));
  if (!plan || c.flags.noInstall) {
    io.out(plan?.manual ?? `  To fix this later: ${ch.label} is needed for ${ch.unlocks}.`);
    return ch;
  }
  if (plan.steps.length === 0) {
    io.out(`  ${plan.manual}`);
    if (id !== "node" && (await yesNo(c.ui, `Have you done that and want me to check ${ch.label} again?`, false))) return probe();
    return ch;
  }
  io.out(`  ${ch.label} is needed for ${ch.unlocks}. To install it I would run:`);
  for (const s of plan.steps) io.out(`    ${[s.cmd, ...s.args].join(" ")}`);
  if (plan.asksForAdmin) io.out("  Your system may ask you to approve this (administrator password or a prompt).");
  if (!(await yesNo(c.ui, `Install ${ch.label} now?`, true))) {
    io.out("  Skipped. You can install it yourself later; run `friend onboard` again and I will pick it up.");
    return ch;
  }
  for (const s of plan.steps) {
    const code = await deps.interactive(s.cmd, s.args);
    if (code !== 0) {
      io.out(`  That did not work (exit code ${code}). You can install ${ch.label} by hand; run \`friend onboard\` again afterwards.`);
      return ch;
    }
  }
  const after = await probe();
  if (after.ok) {
    io.out(`  ✓ ${after.detail}`);
    return after;
  }
  // installed, but a program installed a moment ago is often not on this terminal's PATH yet
  io.out(`  ${ch.label} was installed, but this terminal cannot see it yet. Open a new terminal and run \`friend onboard\` again; it carries on from here.`);
  if (!c.state.restart.includes(id)) c.state.restart.push(id);
  save(c);
  return after;
}

async function prereqs(c: Ctx): Promise<Result> {
  const { io, deps } = c;
  const cfg = loadConfig(io.dataDir);
  const ids: PrereqId[] = ["node", ...c.state.features.flatMap((f) => (FEATURE_PREREQ[f] ? [FEATURE_PREREQ[f]!] : [])), "port"];
  io.out("Checking what this PC has:");
  const results: Check[] = [];
  for (const id of [...new Set(ids)]) {
    const ch = await check(id, deps, { port: cfg.port, claudeCommand: cfg.claudeCode.command });
    results.push(ch);
    c.checks.set(id, ch);
    io.out(`  ${ch.ok ? "✓" : ch.need === "required" ? "✗" : "·"} ${ch.label.padEnd(12)} ${ch.detail}`);
  }
  const node = c.checks.get("node")!;
  if (!node.ok) {
    io.out("");
    io.out(installPlan("node", deps.platform, new Set())!.manual!);
    c.exit = 1;
    return "stop";
  }
  c.state.restart = c.state.restart.filter((id) => !c.checks.get(id as PrereqId)?.ok);
  const missing = results.filter((r) => !r.ok && r.id !== "port" && r.id !== "node");
  if (missing.length) io.out("");
  for (const m of missing) {
    io.out(`${m.label}: ${m.detail}.`);
    const fixed = await fixOne(c, m.id, m);
    c.checks.set(m.id, fixed);
  }
  if (c.state.restart.length) {
    io.out("");
    if (!(await yesNo(c.ui, "Carry on with the other steps now? (The parts that need a new terminal can be finished by running `friend onboard` again.)", true))) {
      io.out("Open a new terminal and run `friend onboard` again.");
      return "stop";
    }
  }
  return "done";
}

async function account(c: Ctx): Promise<Result> {
  const { io } = c;
  const db = openDb(io.dataDir);
  try {
    const auth = new Auth(db, new Audit(db));
    if (auth.hasOwner()) {
      io.out(`There is already an owner account (${auth.assistantName()}), so nothing to do here.`);
      return "done";
    }
    io.out("This is your account. The password signs you in; the PIN approves risky actions (for example running a command).");
    /** A secret typed twice; null when it never matched. Only the one that did not match is asked again. */
    const twice = async (first: string, again: string, mismatch: string): Promise<string | null> => {
      for (let t = 0; t < 3; t++) {
        const a = await io.ask(first, { hidden: true });
        if ((await io.ask(again, { hidden: true })) === a) return a;
        io.out(mismatch);
      }
      return null;
    };
    for (let t = 0; t < 3; t++) {
      const password = await twice("Choose a password (at least 8 characters): ", "Type it again: ", "Those two did not match. Let's try again.");
      const pin = password === null ? null : await twice("Choose a PIN for risky actions (at least 6 digits): ", "Type the PIN again: ", "The PINs did not match. Let's try again.");
      if (password === null || pin === null) break;
      const assistantName = (await text(c.ui, "What should your assistant be called", "Friend")) || "Friend";
      try {
        await auth.setupOwner({ password, pin, assistantName });
      } catch (e) {
        io.out(`${(e as Error).message}. Let's try again.`);
        continue;
      }
      io.out(`Account created. ${assistantName} is yours.`);
      return "done";
    }
    io.out("I could not create the account. Run `friend onboard` again to try once more.");
    return "later";
  } finally {
    db.close();
  }
}

async function model(c: Ctx): Promise<Result> {
  const { io, deps } = c;
  const cfg = loadConfig(io.dataDir);
  let usable: "claude-code" | "claude" | "ollama" | null = null;

  if (has(c, "claude-code")) {
    let ch = await check("claude", deps, { claudeCommand: cfg.claudeCode.command });
    if (!ch.ok) {
      io.out("Claude Code is not installed, so the Claude subscription cannot be used yet. Run `friend onboard` again after installing it.");
    } else {
      if (!ch.signedIn) {
        io.out("Claude Code is installed but you are not signed in.");
        if (await yesNo(c.ui, "Sign in to your Claude account now? A browser window opens for it.", true)) {
          await deps.interactive(cfg.claudeCode.command, ["auth", "login"]);
          ch = await check("claude", deps, { claudeCommand: cfg.claudeCode.command });
        }
      }
      if (ch.signedIn) {
        io.out(`  ✓ ${ch.detail}`);
        cfg.claudeCode.model = await choose(
          c.ui,
          "Which Claude model should answer?",
          [
            { key: "sonnet", label: "Sonnet", hint: "balanced, a good start" },
            { key: "haiku", label: "Haiku", hint: "fastest, uses the least of your plan" },
            { key: "opus", label: "Opus", hint: "the most capable, uses the most" },
          ],
          "sonnet",
        );
        usable = "claude-code";
      } else io.out("Not signed in yet. Run `friend claude setup` after signing in with `claude auth login`.");
    }
  }

  if (has(c, "claude-api")) {
    const key = (c.ui.yes ? "" : await io.ask("Anthropic API key (Enter to add it later with `friend config set apiKey`): ", { hidden: true })).trim();
    if (key) {
      cfg.apiKey = key;
      usable ??= "claude";
    }
  }

  if (has(c, "ollama")) {
    const ch = await check("ollama", deps);
    if (!ch.ok) io.out("Ollama is not installed yet, so the local model is not ready. Run `friend onboard` again after installing it.");
    else {
      io.out(`The local model is ${cfg.ollama.model} (about 4.7 GB the first time).`);
      if (await yesNo(c.ui, "Download it now?", true)) {
        saveConfig(cfg); // the setup command reads the saved configuration
        const code = await deps.ollamaSetup(io, ["setup"]);
        if (code !== 0) io.out("The download did not finish. Run `friend ollama setup` to try again.");
      } else io.out("Skipped. Run `friend ollama setup` when you want it.");
      usable ??= "ollama";
    }
  }

  if (usable === "claude-code") {
    cfg.provider = "claude-code";
    cfg.claudeCode.fallback = has(c, "ollama") ? "ollama" : "none";
  } else if (usable) cfg.provider = usable;
  saveConfig(cfg);

  if (!usable) {
    io.out("No model is ready yet. Finish one of: `friend claude setup --use`, `friend ollama setup --use`, or `friend config set apiKey <key>`.");
    return "later";
  }
  io.out(`Friend will think with: ${cfg.provider === "claude-code" ? `Claude (${cfg.claudeCode.model}) through your subscription${cfg.claudeCode.fallback === "ollama" ? ", with the local model as a safety net" : ""}` : cfg.provider === "claude" ? "Claude with your API key" : cfg.provider === "openai" ? `${cfg.openai.model} through ${cfg.openai.url}` : `${cfg.ollama.model} on this PC`}.`);
  return "done";
}

async function voice(c: Ctx): Promise<Result> {
  const { io, deps } = c;
  if (!has(c, "voice")) {
    io.out("You did not choose voice, so I am skipping it. Add it any time with `friend voice setup`.");
    return "done";
  }
  const py = await check("python", deps);
  if (!py.ok) {
    io.out("Voice needs Python 3.10 or newer, which is not available yet. Install it and run `friend onboard` again.");
    return "later";
  }
  io.out("Voice runs on this PC: it listens with Whisper and speaks with Piper. Nothing you say leaves your PC.");
  if (await yesNo(c.ui, "Set it up now? You pick a female or male voice, then about 250 MB is downloaded.", true)) {
    const code = await deps.voiceSetup(io, []);
    return code === 0 ? "done" : "later";
  }
  io.out("Which voice would you like when you do set it up?");
  const cfg = loadConfig(io.dataDir);
  const pick = await choose(
    c.ui,
    "",
    [
      { key: "female", label: voiceLabel(resolveVoice("female")!.id) },
      { key: "male", label: voiceLabel(resolveVoice("male")!.id) },
      { key: "keep", label: "Decide later" },
    ],
    "keep",
  );
  if (pick !== "keep") {
    cfg.voice.ttsVoice = resolveVoice(pick)!.id;
    saveConfig(cfg);
  }
  io.out("Run `friend voice setup` when you want to finish it.");
  return "later";
}

async function workspace(c: Ctx): Promise<Result> {
  const { io } = c;
  const cfg = loadConfig(io.dataDir);
  io.out("Friend can read and write files freely inside one folder. Anywhere else it asks you first.");
  const current = cfg.roots[0];
  const answer = await text(c.ui, current ? "Workspace folder" : "Workspace folder (Enter to skip)", current ?? "");
  if (answer) {
    const abs = resolve(answer);
    mkdirSync(abs, { recursive: true });
    cfg.roots = [abs];
    saveConfig(cfg);
    io.out(`Workspace: ${abs}`);
  } else io.out("No workspace: every file action will ask first. You can set one later with `friend config set roots <folder>`.");
  return "done";
}

async function network(c: Ctx): Promise<Result> {
  const { io } = c;
  const cfg = loadConfig(io.dataDir);
  const portFree = c.checks.get("port")?.ok ?? true;
  if (!portFree) io.out(`Port ${cfg.port} is already in use on this PC, so Friend needs another one.`);
  const where = await choose(
    c.ui,
    "Who should be able to open Friend?",
    [
      { key: "local", label: "Only this PC", hint: "the safe choice" },
      { key: "lan", label: "Other devices on my network too", hint: "phones and other PCs; plain http" },
    ],
    "local",
  );
  let port = cfg.port;
  if (!portFree || where === "lan" || !c.ui.yes) {
    for (let t = 0; t < 3; t++) {
      const a = Number(await text(c.ui, "Port", String(port)));
      if (Number.isInteger(a) && a >= 1024 && a <= 65535) {
        port = a;
        break;
      }
      io.out("The port must be a whole number from 1024 to 65535.");
    }
  }
  cfg.port = port;
  cfg.bind = where === "lan" ? "0.0.0.0" : "127.0.0.1";
  // A phone is only allowed to use the microphone over https, so on the network it is the sensible default.
  cfg.https = where === "lan" ? await yesNo(c.ui, "Use a secure (https) address so a phone can use the microphone? Your phone will show a one-time certificate warning.", true) : false;
  saveConfig(cfg);
  const u = urlsFor(cfg.bind, cfg.port, undefined, cfg.https);
  io.out(`Friend will be at ${u.local}`);
  for (const n of u.network) io.out(`and on your network at ${n}`);
  if (where === "lan" && !cfg.https) io.out("Note: the microphone and camera only work on this PC (or over HTTPS). Everything else works from the other devices. Later: friend lan https on");
  return "done";
}

async function look(c: Ctx): Promise<Result> {
  const { io } = c;
  const cfg = loadConfig(io.dataDir);
  const pick = await choose(
    c.ui,
    "Pick a look for the voice presence (you can change it any time in Settings):",
    THEMES.map((t) => ({ key: t.id, label: t.name, hint: `${t.style}, ${t.accent}` })),
    THEMES.find((t) => t.style === cfg.look.style && t.accent === cfg.look.accent)?.id ?? "aurora",
  );
  const t = THEMES.find((x) => x.id === pick)!;
  cfg.look = { ...cfg.look, style: t.style, accent: t.accent, intensity: t.intensity };
  saveConfig(cfg);
  io.out(`Look: ${t.name}.`);
  return "done";
}

function summary(cfg: Config, c: Ctx): string[] {
  const u = urlsFor(cfg.bind, cfg.port, undefined, cfg.https);
  const db = openDb(c.io.dataDir);
  let owner = "not created yet";
  try {
    const auth = new Auth(db, new Audit(db));
    if (auth.hasOwner()) owner = auth.assistantName();
  } finally {
    db.close();
  }
  return [
    `  Assistant:  ${owner}`,
    `  Thinks with: ${cfg.provider === "claude-code" ? `Claude (${cfg.claudeCode.model}), your subscription` : cfg.provider === "claude" ? (cfg.apiKey ? "Claude, API key" : "Claude, API key missing") : cfg.provider === "openai" ? `${cfg.openai.model} through ${cfg.openai.url}` : `${cfg.ollama.model} on this PC`}`,
    `  Voice:      ${has(c, "voice") ? voiceLabel(cfg.voice.ttsVoice) : "off"}`,
    `  Workspace:  ${cfg.roots[0] ?? "none (every file action asks)"}`,
    `  Address:    ${u.local}${u.network.length ? ` and ${u.network.join(", ")}` : ""}`,
    `  Look:       ${THEMES.find((t) => t.accent === cfg.look.accent && t.style === cfg.look.style)?.name ?? "custom"}`,
  ];
}

async function finish(c: Ctx): Promise<Result> {
  const { io, deps } = c;
  const cfg = loadConfig(io.dataDir);
  io.out("All set. Here is what you chose:");
  for (const l of summary(cfg, c)) io.out(l);
  io.out("");
  io.out("Change anything later: open Friend and press Esc, then Settings, or run `friend onboard --redo <step>`.");
  io.out("Check this PC any time with `friend doctor`.");
  if (!(await yesNo(c.ui, "Start Friend now?", true))) {
    io.out("Start it whenever you like with: friend start");
    return "done";
  }
  const url = urlsFor(cfg.bind, cfg.port, undefined, cfg.https).local;
  if (await yesNo(c.ui, "Open it in your browser when it is up?", true)) setTimeout(() => void deps.openUrl(url), 2500);
  io.out("Starting Friend. Press Ctrl+C to stop it.");
  c.state.done.finish = new Date().toISOString();
  save(c);
  await deps.start(io);
  return "done";
}

const STEPS: { id: string; title: string; run: (c: Ctx) => Promise<Result> }[] = [
  { id: "welcome", title: "Welcome", run: welcome },
  { id: "features", title: "What you want to use", run: features },
  { id: "prereqs", title: "What this PC needs", run: prereqs },
  { id: "account", title: "Your account", run: account },
  { id: "model", title: "How Friend thinks", run: model },
  { id: "voice", title: "Voice", run: voice },
  { id: "workspace", title: "Your workspace folder", run: workspace },
  { id: "network", title: "Who can open Friend", run: network },
  { id: "look", title: "How it looks", run: look },
  { id: "finish", title: "Finish", run: finish },
];
export const STEP_IDS = STEPS.map((s) => s.id);

export async function onboardCommand(args: string[], io: IO, partial: Partial<OnboardDeps> = {}): Promise<number> {
  const deps: OnboardDeps = { ...defaultOnboardDeps(), ...partial };
  const yes = args.includes("--yes") || args.includes("-y");
  const redo = new Set<string>();
  for (let i = 0; i < args.length; i++) if (args[i] === "--redo" && args[i + 1]) redo.add(args[i + 1]!);
  for (const r of redo) {
    if (!STEP_IDS.includes(r)) {
      io.err(`There is no step "${r}". The steps are: ${STEP_IDS.join(", ")}`);
      return 1;
    }
  }
  if (io.interactive === false && !yes) {
    io.err("The setup asks questions, so it needs a terminal. Open a terminal window and run: friend onboard");
    return 1;
  }
  if (args.includes("--reset")) resetState(io.dataDir);
  const state = loadState(io.dataDir);
  const c: Ctx = { io, ui: { io, yes }, deps, state, flags: { noInstall: args.includes("--no-install") }, exit: 0, checks: new Map() };

  for (const [i, step] of STEPS.entries()) {
    if (state.done[step.id] && !redo.has(step.id) && step.id !== "finish") {
      io.out(`✓ ${step.title} (done earlier)`);
      continue;
    }
    heading(c.ui, i + 1, STEPS.length, step.title);
    const r = await step.run(c);
    if (r === "stop") return c.exit;
    if (r === "done") state.done[step.id] = new Date().toISOString();
    else io.out(`(This step is not finished yet; I will ask again next time.)`);
    saveState(io.dataDir, state);
    // what was chosen earlier decides what the later steps do, so a redo of "features" starts them over too
    if (step.id === "features" && redo.has("features")) for (const later of STEPS.slice(i + 1)) if (["prereqs", "model", "voice"].includes(later.id)) delete state.done[later.id];
  }
  return 0;
}

