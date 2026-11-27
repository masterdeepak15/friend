# Windows PCs: let the assistant use a PC like a person

Add as many Windows PCs as you want. The assistant can then do on them what you would do sitting there: look at the screen, click, type, open apps, wait for things, run commands, work with files, and drive a terminal such as **Claude Code** (open a project, resume an earlier session, answer its menus, give it instructions, check its status).

Nothing of Friend is installed on those PCs. Each one runs a small agent that connects **out** to your Friend (no ports opened), signs in once, stays connected, and starts again by itself after a restart.

## Add a PC

0. **Once:** in Friend open **Plugins**, find **Windows PCs** under *Available*, press **Install** (PIN), then **Turn on** (PIN). It then sits under *Installed* with **Configure**, **Turn off** and **Remove**, like Chrome control.
1. Press **Configure**, then **Add a PC**. Give it a name and choose what it may do (everything starts off). Enter your PIN.
2. Friend shows one line. On the new PC press Start, type `powershell`, paste the line, press Enter. (Or download the small `.cmd` file and double-click it: it is a text file that runs the same line.)
3. The line installs the official **Node.js** (the signature is checked: it must be signed by the OpenJS Foundation) and Friend's **agent** (its checksum is checked) into your own user folder `%LOCALAPPDATA%\Friend\pc-agent`, registers a task that starts the agent at every logon, and starts it. It does not need administrator rights and changes no system setting.
4. A page opens in the browser on that PC. Sign in to Friend there if you are not signed in, check the PC's name, choose what it may do, enter your PIN and approve. (The page is `<your Friend>/pc/approve?code=...`; you can also open it from another device with the code shown on the PC.)
5. The PC shows as **online**. Done: it reconnects by itself, and updates its own agent from your Friend.

The install link works once and for 24 hours. If you lose it: **New install command** next to the PC.

## What a PC may do (you choose, per PC)

| Switch | What it allows |
|---|---|
| Control the screen | Looking at the screen, mouse, keyboard, apps, clipboard, in a **control session** |
| Screenshots | The picture itself (needed to look) |
| Commands and terminals | PowerShell, and terminals such as Claude Code |
| Programs | List and end programs |
| Registry | Read; changes ask you first |
| Files | Off, read only, or read and write, **only inside the folders you list** |

A new PC has everything off. You can change it any time (it takes effect at once), and add your own words that make Friend ask and your own windows it never touches.

## Control sessions

To look at the screen or use the mouse and keyboard the assistant needs a **control session**:

- You start one yourself (**Start control** next to the PC) or the assistant asks you (one card, naming the PC).
- It starts after a 3 second countdown. While it runs the PC shows an **orange border and a banner** at the top, and the assistant moves the mouse smoothly, like a hand.
- **Your own mouse or keyboard use pauses it at once** ("paused by you"). The assistant has to ask again, and it counts down 3 seconds before it moves anything.
- **Ctrl+Alt+Shift+Esc** ends it immediately. It also ends when its time is up, after a long idle time, when the screen connection is lost, and when you revoke the PC.
- Only one session runs on a PC at a time. The assistant can queue **tasks** for a PC; one runs at a time, they survive a restart (a running task comes back paused and is never carried on without a new session), and the PC always keeps a **status** (idle, controlling, paused, waiting, error) with the current task and last action, shown in the list and on the PC.

## What always asks you, and what is never touched

- **Asks you first (a card naming the PC, with what it is about):** deleting files or folders, writing a program file, ending a program, registry changes, shell commands that remove or install or change the system, and a click on a button or menu whose name says *delete, remove, uninstall, erase, format, pay, purchase, buy, send money, transfer, confirm order, factory reset...* This list is fixed; you can only add to it.
- **Never clicked or typed into:** password managers (1Password, Bitwarden, KeePass, LastPass...), Windows' consent (UAC) and security prompts, and bank or payment windows. The assistant tells you to do that step yourself.
- **Never allowed:** anything outside the folders you listed (it is refused, not asked), and starting Claude Code with a flag that skips its permission prompts.
- The audit trail records every call with the PC's name, the tool and the window. **Typed text is recorded only as a length.**

## Terminals and Claude Code

The assistant can open a terminal on a PC (it needs the *Commands and terminals* switch and a folder you allowed), for example "open the shop project in Claude Code and continue yesterday's session". It reads the screen as text, sees whether the program is busy, idle or waiting at a menu (and which options are shown), types instructions, chooses menu options with the arrow keys and Enter, and checks the status again and again. A prompt that asks about something risky (delete, force push, run as administrator...) is **not answered by the assistant on its own**: you are asked. The terminal keeps running between the assistant's turns.

## What works and what does not

- Windows 10 version 1809 or newer and Windows 11 (64-bit). The PC needs internet access to your Friend, and to nodejs.org the first time.
- Programs running as administrator, the UAC prompt, the lock screen and games cannot be controlled. A very busy app (a browser with many tabs) gives a long list of elements: it is cut to a size the assistant can use.
- The installer is a script, not a program, so SmartScreen has nothing to warn about; some antivirus tools are wary of any "download and run" command. If one blocks it, use the `.cmd` file, or tell your antivirus to allow `%LOCALAPPDATA%\Friend\pc-agent`.

## Revoke a PC, and add it again

- **Revoke** (PIN) signs the PC out at once: its agent is told, stops, removes its own logon task and cannot connect any more. The PC stays in the list as *revoked*.
- To use that PC again press **Add again** (PIN). Friend makes a **new install command** for it (it keeps its name and permissions) and the old sign-in stays dead.
- On that PC open PowerShell and **run the new command**. It is safe to run over the old install: it reuses the files already there, registers the logon task again, starts the agent, and opens the approval page. Approve it with your PIN and the PC is online again.
- For a PC you never finished adding (the command was lost, or the page was never approved), use **New install command** next to it instead.

## Remove a PC

**Revoke** in Friend signs it out at once (it stops and cannot connect again). To take the agent off the PC: run `node.exe agent.cjs --uninstall` in `%LOCALAPPDATA%\Friend\pc-agent`, or delete the task "Friend PC Agent" in Task Scheduler and the folder.

## It stays online

You approve a PC once, with its code. After that it signs itself in again and again by itself: nothing has to be approved after a restart, an update or a lost connection.

- **One agent at a time.** A second copy (started by hand, or an update starting while the old one ends) would share the same sign-in. The agent keeps a lock file, so a second copy stops quietly.
- **A lost reply does not cost the approval.** The sign-in is renewed by trading a secret for a new one. If the reply is lost (a restart, a crash), asking again with the old secret within 15 minutes is taken as a retry and gets a new one. Only the old secret used again much later (a sign of a copy) revokes the PC, as before.
- **No window.** The task does not run 
ode.exe (a console program, which would open a terminal at every logon and restart). It runs a tiny launcher (un.vbs, by Windows Script Host) that starts the agent with no window at all. You never see a terminal. It starts when you log in to Windows (with automatic sign-in that is at startup); starting before anyone signs in would need administrator rights, which Friend never asks for.
- **It starts again by itself.** The logon task starts the agent at every logon and also every five minutes if it is not running (an update or a crash used to leave the PC offline until the next logon). While it runs, the task ignores that trigger. A PC that was installed before this keeps the task it has until the agent, on its next start, adds the second trigger to its own task.
- **Only removing the PC ends it.** If you remove the PC in Friend, the agent stops and removes its task. Nothing else does.

What can still ask you is the safety floor and not the connection: a button that cannot be undone (delete, uninstall, format, pay) or a risky question in a terminal asks first, whatever was approved before.
