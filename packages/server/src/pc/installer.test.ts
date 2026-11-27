import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PC_NODE_VERSION, installCmd, installCommand, installScript } from "./installer";

const input = { server: "https://maya.example.com", name: "Office PC", enrollmentId: "abc_DEF-123", agentSha256: "A".repeat(64) };

describe("the install script a new PC runs", () => {
  const script = installScript(input);

  it("carries the address, the name, the one-time id and the checksum of the agent", () => {
    expect(script).toContain("$server = 'https://maya.example.com'");
    expect(script).toContain("$pcName = 'Office PC'");
    expect(script).toContain("$enroll = 'abc_DEF-123'");
    expect(script).toContain(`$agentSha = '${"a".repeat(64)}'`);
    expect(script).toContain(`$nodeVersion = '${PC_NODE_VERSION}'`);
  });

  it("checks that Node.js is signed by the OpenJS Foundation and that the agent matches its checksum, and installs nothing otherwise", () => {
    expect(script).toContain("Get-AuthenticodeSignature");
    expect(script).toContain("OpenJS Foundation");
    expect(script).toMatch(/Status -ne 'Valid'[\s\S]*throw/);
    expect(script).toContain("Get-FileHash");
    expect(script).toMatch(/\$got -ne \$agentSha[\s\S]*throw/);
    expect(script).toContain("https://nodejs.org/dist/");
  });

  it("is made for one user: the user's own folder, a task of that user, never as administrator, no system setting changed", () => {
    expect(script).toContain("$env:LOCALAPPDATA");
    expect(script).toContain("-RunLevel Limited");
    expect(script).toContain("-LogonType Interactive");
    expect(script).toContain("-AtLogOn");
    expect(script).toContain("-RestartCount 999");
    expect(script).not.toMatch(/Set-ExecutionPolicy|-Verb RunAs|HKLM|Add-MpPreference|Set-MpPreference/);
  });

  it("is safe to run twice: it stops a running agent first, and reuses the Node.js that is there", () => {
    expect(script).toContain("Stop-ScheduledTask");
    // it starts without a terminal window and does not leave the PC offline: a launcher with no window, and a second trigger every five minutes
    expect(script).toContain("-Execute 'wscript.exe'");
    expect(script).toContain("run.vbs");
    expect(script).not.toMatch(/New-ScheduledTaskAction -Execute \$nodeExe/);
    expect(script).toContain("-RepetitionInterval (New-TimeSpan -Minutes 5)");
    expect(script).toContain("Stop-Process");
    expect(script).toContain("$have -eq $nodeVersion");
  });

  it("quotes a name or address with an apostrophe so it cannot break out of the string", () => {
    const evil = installScript({ ...input, name: "Bob's PC'; Remove-Item C:\\ -Recurse #" });
    expect(evil).toContain("$pcName = 'Bob''s PC''; Remove-Item C:\\ -Recurse #'");
  });

  it("uses no backticks, so it also survives being pasted through a terminal", () => {
    expect(script).not.toContain("`");
  });

  it.skipIf(process.platform !== "win32")("is valid PowerShell (checked with the real parser)", () => {
    const file = join(mkdtempSync(join(tmpdir(), "friend-install-")), "install.ps1");
    writeFileSync(file, script, "utf8");
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", `$e = $null; $t = $null; [void][System.Management.Automation.Language.Parser]::ParseFile($env:FR_FILE, [ref]$t, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.Message + ' at line ' + $_.Extent.StartLineNumber }; exit 1 } else { 'ok' }`],
      { env: { ...process.env, FR_FILE: file }, encoding: "utf8" },
    );
    expect(out.trim()).toBe("ok");
  });
});

describe("the command the owner copies", () => {
  it("is one line that downloads the script and runs it, with the policy bypassed for this run only", () => {
    const c = installCommand("https://maya.example.com", "abc_DEF-123");
    expect(c).toBe(`powershell -NoProfile -ExecutionPolicy Bypass -Command "irm 'https://maya.example.com/api/pc/install.ps1?enrollment=abc_DEF-123' | iex"`);
    expect(c).not.toContain("\n");
  });

  it("is also a small text file that runs the same command, and waits at the end so the person can read it", () => {
    const f = installCmd("https://maya.example.com", "abc_DEF-123");
    expect(f).toContain("irm 'https://maya.example.com/api/pc/install.ps1?enrollment=abc_DEF-123' | iex");
    expect(f).toMatch(/^@echo off/);
    expect(f).toMatch(/pause\r\n$/);
    expect(f).not.toMatch(/\.exe\b.*\bhttp/); // it does not download a program
  });
});
