# Many PCs, one assistant: the PC agents plugin

Status: **superseded by `2026-11-27-windows-pcs-design.md`** (the owner replaced the PC agents idea with a Windows PCs plugin that operates the PC like a person). Kept for its permission model, which the new design reuses.

## Why

The owner controls the hosted PC through Friend and wants to do the same with other PCs (Windows, Mac, Linux): add a PC from a plugin, install a small agent, approve it once, then have the assistant act on that PC remotely with the permissions the owner chose for it.

## Today (found in the code)

- `friend node --url …/device --code <code>` pairs a PC; the server keeps it in `DeviceHub`.
- A PC offers files, shell and system tools; files are limited by `--roots` chosen when the agent starts.
- Calls go to the most recently connected PC; the assistant cannot name one.
- Permissions are not stored per PC on the server. The pairing token never expires and cannot be revoked from the screen.

## Goals

- A **PCs** plugin: list (name, OS, online, last seen), Add, Revoke, edit permissions.
- Add a PC with a download for its OS and one approval (screen or phone link). No code typing.
- Permissions **per PC**, held on the server, enforced on the server and again on the PC.
- The assistant addresses a PC by name; asks which when unclear.
- Everything remote is audited with the PC's name.

## Non-goals

- Not a remote desktop or screen streaming product.
- No inbound ports on the owner's PCs: the agent dials out to Friend.
- No cloud relay run by us; the host's own address is used.

## Anti-goals

- A newly added PC that can do anything before the owner chose.
- The assistant widening a PC's permissions, or approving its own critical action.
- A stolen agent token working forever or from another machine.

## Permissions (decided with the owner)

No "ask every time" prompt. A PC either may do a thing or may not. **Only critical actions ask**, on the screen or the phone like Friend's usual approval cards.

Per PC the owner sets:
- **Files:** off, read only, or read and write, limited to chosen folders.
- **Shell:** off or on.
- **System info:** off or on.
- **Screen and camera:** off or on (critical when on: asks).
- Default for a new PC: everything off until chosen on the approval step.

**Critical (fixed floor, always asks even on an "on" PC):** deleting or overwriting files, shell commands that delete, format, change system settings or the registry, install or uninstall software, power off or restart, escalate privileges, download-and-run, and any screen or camera capture. The exact classifier is the builder's; the floor cannot be turned off. The owner may add more critical patterns in settings.

**Outside the allowed folders:** refused, never asked.

## Approaches considered

- A. Extend the existing `friend node` pairing with per-device records and a plugin UI. *(chosen: smallest, reuses what works)*
- B. Replace the agent with a new signed binary per OS. More polished download, much more to build and sign.
- C. Run each PC's agent as an MCP server and use the connector hub. Reuses connectors, but loses the per-PC permission model and the existing tools.

The download in A is the existing `friend` CLI (npm `friend-assistant`, Node) with a one-line installer per OS; a single-file binary is a later option.

## Design

**Add flow (device authorization style, RFC 8628).** The plugin makes a one-time link. On the new PC: `friend node --link <link>` (the installer command shown per OS). The PC shows nothing to type; the owner approves on the screen or phone, picks the permissions and a name, and Friend returns a long-lived **device token** bound to that PC (stored hashed server side, sealed on the PC) that can be rotated and revoked.

**Server.** `devices` records gain: name, os, permissions (JSON), last seen, revoked. `DeviceHub.exec(deviceId, …)` replaces "most recent". Permissions are checked before a call is sent; the PC checks again (defence in depth). A revoked token closes the socket at once.

**Tools.** The assistant's device tools gain a `pc` argument (name). Unknown or ambiguous name: ask which. Offline PC: say so.

**Critical actions.** Reuse the approval card; the card names the PC and shows the exact command or path.

**Agent.** `friend node` gains `--link`, reconnects with its token, sends OS and name on hello, enforces its own copy of the permissions, and keeps the `--roots` idea as the folder limit.

**Audit.** `pc.added`, `pc.revoked`, `pc.permissions`, and one line per remote call with the PC name and outcome.

## Constraints

Free only; cross-platform (Windows, macOS, Linux); permissions are settings, the critical floor is fixed; outbound connection only.

## Left to the builder

Installer wording per OS, the critical-command classifier details, token rotation interval, UI layout.
