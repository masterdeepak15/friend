import { execFile, execFileSync, spawn } from "node:child_process";
import { readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const TASK = "Friend PC Agent";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Whether a process with this id is a running Node program (a stale id that another program got since is not an agent). */
function runningAgent(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EPERM") return false;
  }
  if (process.platform !== "win32") return true;
  try {
    return /node\.exe/i.test(execFileSync("tasklist.exe", ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"], { windowsHide: true, encoding: "utf8", timeout: 8000 }));
  } catch {
    return true; // cannot tell: assume it is
  }
}

/**
 * One agent at a time. Two agents would use the same sign-in, and the second to renew it would be taken for a copy. An agent that is just
 * being replaced (an update) gets a few seconds to finish. False when another one is running and this one should stop quietly.
 */
export async function takeLock(dir: string, log: (line: string) => void, waitMs = 8000): Promise<boolean> {
  const file = join(dir, "agent.pid");
  const deadline = Date.now() + waitMs;
  for (;;) {
    let other = 0;
    try {
      other = Number(readFileSync(file, "utf8").trim()) || 0;
    } catch {
      /* no lock yet */
    }
    if (!other || other === process.pid || !runningAgent(other)) break;
    if (Date.now() > deadline) {
      log(`another agent is running (process ${other}): this one stops`);
      return false;
    }
    await sleep(500);
  }
  try {
    writeFileSync(file, String(process.pid));
  } catch {
    /* without a lock file it still runs */
  }
  process.on("exit", () => {
    try {
      if (readFileSync(file, "utf8").trim() === String(process.pid)) unlinkSync(file);
    } catch {
      /* already gone */
    }
  });
  return true;
}

const POWERSHELL = ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command"];

/** After an update the program ends and the logon task starts it again: this asks for that a few seconds later, when the task has ended. */
export function restartSoon(dir: string, log: (line: string) => void): void {
  if (process.platform !== "win32" || process.env.FRIEND_PC_NO_TASK) return;
  try {
    spawn("powershell.exe", [...POWERSHELL, `Start-Sleep -Seconds 4; Start-ScheduledTask -TaskName '${TASK}'`], { cwd: dir, detached: true, stdio: "ignore", windowsHide: true }).unref();
  } catch (e) {
    log(`could not ask for a restart: ${(e as Error).message}`);
  }
}

/**
 * The logon task starts the agent at logon. That is not enough to stay available: an update, a crash or a program that was ended leaves
 * the PC offline until the next logon. This adds a second trigger to the same task that starts it every five minutes; while the agent is
 * running the task ignores it. Only the agent's own task is changed, and only when it has no such trigger yet.
 */
export async function ensureWatchdog(log: (line: string) => void): Promise<void> {
  if (process.platform !== "win32" || process.env.FRIEND_PC_NO_TASK) return;
  const script = `$ErrorActionPreference = 'Stop'
$task = '${TASK}'
$t = Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue
if (-not $t) { Write-Output 'no task'; exit 0 }
foreach ($x in $t.Triggers) { if ($x.Repetition -and $x.Repetition.Interval) { Write-Output 'already'; exit 0 } }
$who = $env:USERDOMAIN + '\\' + $env:USERNAME
$triggers = @((New-ScheduledTaskTrigger -AtLogOn -User $who), (New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(2)) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)))
Set-ScheduledTask -TaskName $task -Trigger $triggers | Out-Null
Write-Output 'added'`;
  await new Promise<void>((resolve) => {
    execFile("powershell.exe", [...POWERSHELL, script], { windowsHide: true, timeout: 30_000 }, (e, out) => {
      if (e) log(`could not check the restart task: ${e.message.split("\n")[0]}`);
      else if (/added/.test(out)) log("the logon task now also starts the agent again every five minutes if it is not running");
      resolve();
    });
  });
}
