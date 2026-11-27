/** The Node.js version the agent runs on. It has the built-in SQLite (node:sqlite). */
export const PC_NODE_VERSION = "v24.21.0";

export interface InstallInput {
  /** The address the PC reaches Friend at, without a trailing slash. */
  server: string;
  name: string;
  enrollmentId: string;
  /** SHA-256 (hex) of the agent file the script downloads. */
  agentSha256: string;
}

const ps = (s: string): string => `'${s.replace(/'/g, "''")}'`;

/**
 * The PowerShell that sets a PC up: downloads the official, signed Node.js and Friend's agent file into the user's own folder, checks
 * the signature of the first and the checksum of the second, registers a logon task that restarts the agent after a restart or a
 * crash, and starts it so the owner can approve the PC. It never runs as administrator and changes no system setting.
 * Written for Windows PowerShell 5.1 (it has to run on every Windows 10 and 11) and without backticks, so it quotes with [char]34.
 */
export function installScript(i: InstallInput): string {
  return `# Friend PC agent installer. It puts the agent in %LOCALAPPDATA%\\Friend\\pc-agent and starts it at every logon.
# It downloads the official Node.js (signed by the OpenJS Foundation: the signature is checked) and the agent file from your Friend (its checksum is checked).
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$server = ${ps(i.server)}
$pcName = ${ps(i.name)}
$enroll = ${ps(i.enrollmentId)}
$agentSha = ${ps(i.agentSha256.toLowerCase())}
$nodeVersion = ${ps(PC_NODE_VERSION)}
$q = [char]34
$dir = Join-Path $env:LOCALAPPDATA 'Friend\\pc-agent'
$task = 'Friend PC Agent'
$nodeExe = Join-Path $dir 'node.exe'
$agent = Join-Path $dir 'agent.cjs'

Write-Host ('Installing the Friend PC agent for ' + $pcName + ' ...')
New-Item -ItemType Directory -Force -Path $dir | Out-Null

# an agent that is running already (this is an update in place): stop it first
if (Get-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue) { Stop-ScheduledTask -TaskName $task -ErrorAction SilentlyContinue }
Get-Process -Name node -ErrorAction SilentlyContinue | Where-Object { $_.Path -eq $nodeExe } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Sleep -Milliseconds 700

# 1. Node.js, only if this exact version is not there yet
$needNode = $true
if (Test-Path $nodeExe) { $have = (& $nodeExe --version 2>$null); if ($have -eq $nodeVersion) { $needNode = $false } }
if ($needNode) {
  $part = $nodeExe + '.part'
  Write-Host ('Downloading Node.js ' + $nodeVersion + ' from nodejs.org ...')
  Invoke-WebRequest -UseBasicParsing -Uri ('https://nodejs.org/dist/' + $nodeVersion + '/win-x64/node.exe') -OutFile $part
  $sig = Get-AuthenticodeSignature -FilePath $part
  if ($sig.Status -ne 'Valid' -or $sig.SignerCertificate.Subject -notmatch 'OpenJS Foundation') {
    Remove-Item $part -Force -ErrorAction SilentlyContinue
    throw ('The Node.js file is not signed by the OpenJS Foundation (' + $sig.Status + '). Nothing was installed.')
  }
  Move-Item -Force $part $nodeExe
}

# 2. the agent, checked against the checksum Friend gave in this command
Write-Host 'Downloading the agent from Friend ...'
$part = $agent + '.part'
Invoke-WebRequest -UseBasicParsing -Uri ($server + '/api/pc/agent.js?enrollment=' + [uri]::EscapeDataString($enroll)) -OutFile $part
$got = (Get-FileHash -Path $part -Algorithm SHA256).Hash.ToLower()
if ($got -ne $agentSha) {
  Remove-Item $part -Force -ErrorAction SilentlyContinue
  throw 'The agent file did not match its checksum. Nothing was installed.'
}
Move-Item -Force $part $agent

# 3. start at every logon, and every five minutes if it is not running (after a crash or an update; while it runs the task ignores the trigger)
$who = $env:USERDOMAIN + '\\' + $env:USERNAME
$action = New-ScheduledTaskAction -Execute $nodeExe -Argument ($q + $agent + $q) -WorkingDirectory $dir
$trigger = @((New-ScheduledTaskTrigger -AtLogOn -User $who), (New-ScheduledTaskTrigger -Once -At ((Get-Date).AddMinutes(2)) -RepetitionInterval (New-TimeSpan -Minutes 5) -RepetitionDuration (New-TimeSpan -Days 3650)))
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -StartWhenAvailable -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero) -MultipleInstances IgnoreNew
$principal = New-ScheduledTaskPrincipal -UserId $who -LogonType Interactive -RunLevel Limited
Register-ScheduledTask -TaskName $task -Action $action -Trigger $trigger -Settings $settings -Principal $principal -Force | Out-Null

# 4. the first start: it opens the approval page in your browser
Write-Host 'Starting the agent. Approve this PC in your browser.'
$run = @(($q + $agent + $q), '--server', ($q + $server + $q), '--name', ($q + $pcName + $q), '--enroll', $enroll)
Start-Process -FilePath $nodeExe -ArgumentList $run -WorkingDirectory $dir -WindowStyle Hidden
Write-Host 'Done. After you approve it, this PC stays connected and starts again by itself after a restart.'
`;
}

/** The one line the owner copies into PowerShell on the new PC. */
export function installCommand(baseUrl: string, enrollmentId: string): string {
  return `powershell -NoProfile -ExecutionPolicy Bypass -Command "irm '${baseUrl}/api/pc/install.ps1?enrollment=${encodeURIComponent(enrollmentId)}' | iex"`;
}

/** The same command as a small file to double-click. It is a text file, not a program. */
export function installCmd(baseUrl: string, enrollmentId: string): string {
  return `@echo off\r\ntitle Friend PC agent\r\necho Installing the Friend PC agent ...\r\n${installCommand(baseUrl, enrollmentId).replace(/%/g, "%%")}\r\necho.\r\npause\r\n`;
}
