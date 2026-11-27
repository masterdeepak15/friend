import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { homedir, hostname, release } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { PcAgent } from "./agent";
import { Helper, powershellSpawner } from "./helper";
import { AgentStore } from "./store";
import { ensureWatchdog, restartSoon, takeLock } from "./watchdog";

const VERSION = process.env.FRIEND_PC_AGENT_VERSION ?? "0.1.97";
const TASK = "Friend PC Agent";

function parse(argv: string[]): Record<string, string | true> {
  const out: Record<string, string | true> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (!a.startsWith("--")) continue;
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith("--")) {
      out[a.slice(2)] = next;
      i++;
    } else out[a.slice(2)] = true;
  }
  return out;
}

const windowsName = (): string => `Windows ${/^10\.0\.(2[2-9]\d{3})/.test(release()) ? "11" : "10"}`;

/** Removes the logon task, then (after this program has ended) the folder. */
function uninstall(dir: string): never {
  execFile("schtasks.exe", ["/delete", "/tn", TASK, "/f"], { windowsHide: true }, () => {});
  const ps = `Start-Sleep -Seconds 3; Remove-Item -LiteralPath $env:FR_DIR -Recurse -Force -ErrorAction SilentlyContinue`;
  spawn("powershell.exe", ["-NoProfile", "-WindowStyle", "Hidden", "-Command", ps], { detached: true, stdio: "ignore", windowsHide: true, env: { ...process.env, FR_DIR: dir } }).unref();
  console.log("Friend PC Agent is being removed from this PC.");
  process.exit(0);
}

async function main(): Promise<void> {
  const args = parse(process.argv.slice(2));
  const dir = process.env.FRIEND_PC_DIR ?? join(process.env.LOCALAPPDATA ?? homedir(), "Friend", "pc-agent");
  mkdirSync(dir, { recursive: true });
  if (args.uninstall) return uninstall(dir);

  const logFile = join(dir, "agent.log");
  const log = (line: string): void => {
    const text = `${new Date().toISOString()} ${line}\n`;
    try {
      if (existsSync(logFile) && statSync(logFile).size > 1_000_000) truncateSync(logFile, 0);
      appendFileSync(logFile, text);
    } catch {
      /* the log is a convenience */
    }
    if (process.stdout.isTTY) process.stdout.write(text);
  };

  // one agent at a time: two of them would use the same sign-in and one would lose it (a second program started by hand, an update restarting)
  if (!(await takeLock(dir, log))) process.exit(0);
  const store = new AgentStore(join(dir, "agent.db"));
  if (typeof args.server === "string") store.set("server", args.server.replace(/\/+$/, ""));
  if (typeof args.name === "string") store.set("name", args.name);
  const server = store.get("server");
  if (!server) {
    log("No server address: run the install command from Friend (Plugins, Windows PCs, Add PC).");
    process.exit(2);
  }

  const self = process.argv[1] ?? "";
  const agentSha256 = self && existsSync(self) ? createHash("sha256").update(readFileSync(self)).digest("hex") : undefined;
  // `agent` is used by the helper's event handler before it exists only if an event arrives during construction
  const holder: { agent?: PcAgent } = {};
  const helper = new Helper({ spawn: powershellSpawner(join(dir, "helper")), onEvent: (e, d) => holder.agent?.onHelperEvent(e, d) });

  const selfUpdate = async (url: string, sha256: string): Promise<void> => {
    if (!url.startsWith("/api/pc/agent.js") || !self || sha256 === agentSha256) return;
    try {
      const token = await agent.session.access();
      if (!token || token === "offline") return;
      const res = await fetch(`${server}${url}`, { headers: { authorization: `Bearer ${token}` } });
      const body = Buffer.from(await res.arrayBuffer());
      if (!res.ok || createHash("sha256").update(body).digest("hex") !== sha256) throw new Error("the new agent did not match its hash");
      writeFileSync(`${self}.new`, body);
      renameSync(`${self}.new`, self);
      log(`updated to ${sha256.slice(0, 8)}, restarting`);
      restartSoon(dir, log);
      process.exit(75);
    } catch (e) {
      log(`update failed: ${(e as Error).message}`);
    }
  };

  const agent = new PcAgent({
    store,
    helper,
    server,
    version: VERSION,
    os: windowsName(),
    host: hostname(),
    ...(agentSha256 ? { agentSha256 } : {}),
    ...(typeof args.enroll === "string" ? { enrollmentId: args.enroll } : {}),
    connect: (url, token) => new WebSocket(url, { headers: { authorization: `Bearer ${token}` }, handshakeTimeout: 15_000 }) as never,
    show: (url, code) => {
      log(`Approve this PC in Friend: ${url}  (code ${code})`);
      console.log(`\nFriend PC Agent\n  Approve this PC: ${url}\n  Code: ${code}\n`);
      if (!process.env.FRIEND_PC_NO_BROWSER) execFile("cmd.exe", ["/c", "start", "", url], { windowsHide: true }, () => {}); // (the switch is for runs without a person at the screen)
    },
    log,
    onUpdate: (url, sha) => void selfUpdate(url, sha),
    onRevoked: () => {
      log("This PC was removed by the owner. Stopping.");
      execFile("schtasks.exe", ["/delete", "/tn", TASK, "/f"], { windowsHide: true }, () => setTimeout(() => process.exit(0), 500));
    },
  });
  holder.agent = agent;
  // it has to stay available: the logon task also starts it again every few minutes if it is not running (an update, a crash)
  void ensureWatchdog(log);
  const stop = (): void => void agent.stop().finally(() => process.exit(0));
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  log(`Friend PC Agent ${VERSION} starting (${windowsName()}, ${hostname()}), server ${server}`);
  try {
    await agent.start();
  } catch (e) {
    log(`Cannot start: ${(e as Error).message}`);
    console.error((e as Error).message);
    process.exit(3);
  }
}

void main();
