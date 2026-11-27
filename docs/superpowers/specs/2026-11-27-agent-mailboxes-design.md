# Agent mailboxes: email as a channel for any Office role

Status: draft for approval (2026-11-27). Supersedes the generic "Email Capability Plugin" prompt where they differ.

## Intent

Give the assistant and the agents hired in the Office **their own email addresses**. An agent with a mailbox can receive mail, act on it by its guidelines, answer, and report by mail, like a person with a work address. The role is not fixed: support, IT monitor, sales follow-up, bookkeeper, anything the owner describes. The owner wants, for example, to hire an **IT monitor** that watches servers by guidelines the owner or the assistant wrote, acts within what it is allowed, and sends reports by email.

## Goals

- A **Mailboxes** plugin (Available, Install, Turn on, Configure, Remove, like the other plugins) holding any number of mailboxes.
- Any Office worker can be given a mailbox and a **role**: guidelines text, allowed tools, autonomy per action, who it may write to, when it reports.
- **Only the owner gives orders.** Everyone else's mail is data, never instruction.
- Every send passes an approval ladder enforced in code (ask me, the assistant reviews, automatic), per role and per kind of action.
- **Templates**: the assistant designs a mail template on request, stores it, and uses it (alerts, daily status).
- **Watches**: cheap checks (HTTP, TCP, ping, a PC process, a command result) that wake an agent only when something changes, so monitoring does not burn tokens.
- Works with no UI; the UI is a management page only.

## Non-goals and anti-goals

- Not an Outlook clone: no mail reading screen, no folders UI.
- No second agent runtime, second approval system or second scheduler. Reuse the Office gate/judge/assistantApprovals, `proactive/beat`, the OAuth vault.
- Anti-goal: an email that talks an agent into doing something. A design where the model's obedience is the guard is a failure.
- Anti-goal: mail loops, replies to newsletters, mass mailing.

## Trust model (fixed in code, not configurable below these floors)

Each incoming message is classified before any model sees it:

| Class | How it is known | What it may cause |
|---|---|---|
| Owner | From address in the owner list **and** SPF/DKIM/DMARC pass (a plugin setting can require a PIN-style code phrase too) | Orders: the agent acts, with the normal approvals |
| System sender | Allow-listed address or domain per mailbox (a monitoring tool, a bank) | Data for the role's own tools only |
| Anyone else | default | Data. The agent may draft a reply to that sender only |

Tool authority comes from the role's grant plus the class, never from the text of the mail. Fixed floors: no reply to bulk or automatic mail (`List-Unsubscribe`, `Precedence: bulk`, `Auto-Submitted`, no-reply senders); per-sender and per-hour reply limits; new recipients or forwarding need approval unless the role lists the domain; attachments are listed, not opened or run, without approval; mail text is passed to the model as clearly marked untrusted content; tokens and passwords live only in the vault and never enter a prompt or a log; every send records who approved it.

## Approval ladder

Per role and per action kind (reply, send, forward, delete/archive, run a tool): **ask** (a card on phone/screen), **assistant reviews** (the Office judge checks the draft against the role's guidelines; clean ones go, doubtful ones come to the owner), or **auto** (only for kinds the owner lists, for example "daily status to me"). Default is ask. Delete is disabled by default.

## How it fits the Office

- A mailbox belongs to one worker by default; sharing needs an explicit routing rule.
- The role lives with the worker (guidelines, capabilities, autonomy, report schedule). Hiring a worker from a description ("monitor my servers and email me when anything breaks") produces a role draft the owner approves.
- Each conversation becomes a **case** on the Office board (thread, status, drafts, approvals, history), whatever the role.
- Incoming mail, a due schedule and a watch change all arrive as events to the same worker runner. Duplicate notifications never run twice (unique key: mailbox + provider message id; sync cursor stored for catch-up after downtime).

## IT monitor example

Guidelines (written by the owner or proposed by the assistant): watch `https://shop.example.com` and the database port every 5 minutes; if down twice in a row, collect the last 50 log lines from the server PC and email the owner; restarting the service is allowed only after approval; every day 08:00 send the status template. The watch fires the agent only on a state change; the agent drafts the alert from the template; the ladder decides whether it is sent at once.

## Approaches considered

1. **Mailbox as an Office capability** (chosen): reuses the gate, judge, scheduler, vault, plugin card; one approval inbox.
2. A separate email subsystem with its own agents and approvals: duplicates infrastructure and creates two approval systems. Rejected.
3. Only expose a Gmail/IMAP MCP server and prompt the model to be careful: the guard would be the prompt. Rejected.

## Providers

IMAP + SMTP with an app password first (covers Gmail, Microsoft 365 and any host, no app registration). Gmail OAuth (API, watch, history) and Microsoft Graph (subscriptions, delta) later, each behind the same `MailProvider` interface in its own file. SMTP only sends. IMAP uses IDLE with polling fallback. A lost or revoked sign-in shows the mailbox as "needs sign-in" and the assistant tells the owner.

## Data (migration after 23)

`mail_accounts`, `mail_messages` (metadata, short-retention body, provider ids, thread), `mail_events` (idempotency, status, attempts, dead letter), `mail_rules` (conditions and actions), `mail_templates`, `mail_cases`, `mail_sends` (draft, approver, result). Secrets by vault reference only.

## Tools (through the existing tool registry)

`email.inbox`, `email.read`, `email.search`, `email.send`, `email.reply`, `email.forward`, `email.draft`, `email.mark_read`, `email.archive`, `email.attachments`, `email.template` (list, save, use), `watch.*` (add, list, remove). Each validated, permission-checked, audited.

## Phases (each shippable)

1. Core: provider interface, IMAP/SMTP, vault, sync + idempotent events, classification, guards, tools, approval ladder, plugin card. Tests with a fake provider and a local mail server.
2. Rules, templates, scheduled reports, watches.
3. Office roles: give a worker a mailbox and role, cases on the board, hire-from-description.
4. Gmail OAuth, Microsoft Graph.

## Left to the builder

Exact Office hooks (worker store, gate, judge wiring), library choice for IMAP/SMTP/parsing (prefer well-maintained `imapflow`, `nodemailer`, `mailparser`, checked for licence and size), retention defaults, template variable syntax.
