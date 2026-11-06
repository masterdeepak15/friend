# Audit trail and report: design

Date: 2026-11-06. Status: written for the owner's review. First of two sub-projects (the second is the security review and fixes, designed afterwards and using this trail).

## Purpose

The owner wants to see what Maya (the assistant), the hired Office workers and the owner did, including every approval, so that when something goes wrong it can be found and fixed. Today Friend writes about 90 kinds of events to an `audit_log` table, but nothing reads it, it can be edited silently, events cannot be followed from one request to what it caused, and a worker's action is indistinguishable from Maya's ("agent").

Success means the owner can: open a report and filter by who, what and result; follow one request from the beginning to everything it caused; export it; ask Maya about it safely; and detect, even if the PC is fully controlled by someone else, that history was changed.

## Decisions already made with the owner

| Question | Decision |
|---|---|
| Detail level | Full: exact commands, paths, URLs, messages sent, card text, worker requests and reports. Secrets masked. |
| Tamper protection | Hash chain plus a daily seal sent to the owner's phone. |
| Where to read | Screen in Friend, command line, export file, and "ask Maya" with a PIN each time. |
| Retention | 90 days by default; the owner can set the number of months/days (0 = keep forever). |
| Approach | A: grow the existing `audit_log` in place. The existing log calls keep working. |

## Non-goals

- The attacker-view security review and its fixes (second sub-project).
- Replacing the ~90 free-text log calls with typed events (approach C), or a separate store (approach B).
- Real-time alerting beyond the existing alerts and the daily seal.

## 1. What each entry holds

New columns on `audit_log` (migration 16; old columns unchanged):

- `actor_kind`: `owner | assistant | worker | system | outsider`. `actor_id`: a name or id (`maya`, `Dev (be8d8dca)`, the remote address for an outsider). The old `actor` text stays for compatibility; old values map `owner->owner`, `agent->assistant` (or `worker` when the detail names a worker), `system->system`, `anonymous->outsider`.
- `request_id`, `parent_id`: see section 2.
- `target`: short text for what was acted on (tool name, file, URL, recipient). `outcome`: `started | done | refused | failed | waiting`.
- `detail_json`: the full detail with secrets masked. Masking applies to key names (password, pin, token, secret, key, authorization, cookie) and to values that look like secrets (`sk-...`, bot tokens, long hex or base64 runs, `Bearer ...`). Each entry's detail is capped at 8 KB; a longer value is cut and the entry stores the hash of the full text and `truncated: true`.
- `prev_hash`, `hash`: `hash = SHA-256(prev_hash || canonical(row fields))`. A start-of-chain entry is written by the migration with the count of older unchained rows; those rows are marked `legacy`.
- Indexes on `request_id`, `ts`, `actor_kind`, `kind`.

`Audit.log(actor, kind, detail)` keeps its signature. It takes the request id and actor kind from the context (below) and from the old `actor` text, and fills the rest. A new `Audit.record({ kind, target, outcome, ... })` is used by the choke points.

## 2. Request tracing

A request id is created at each entry point and carried through everything it causes with `AsyncLocalStorage`, so no function signature changes:

- an owner chat or voice turn; a Telegram, WhatsApp or SMS message; an Alexa request; a reminder or check-in; the Office finished-ticket turn; the assistant's approval round; a worker run.
- A ticket stores the request id that created it. A worker run gets its own request id with `parent_id` set to that, so the worker's later actions link back to the owner's request.
- Nested work (tool calls, approvals, Office requests) inherits the current id.

## 3. What is recorded (complete by construction)

Recording happens at the points everything passes through, not in each feature:

1. **Tool dispatcher** (every tool of Maya and of the worker bridge): an entry `started` just before the call (who, request id, exact arguments, masked) and one after (`done | failed | refused`, with the first 300 characters of the result). A crash leaves the first entry.
2. **HTTP hook** (`onResponse`) on every route that is not a plain read: method, route, actor, address, status.
3. **WebSocket handler:** every client message type, including approval answers, setting changes and stopping a worker.
4. **Approvals, whole life:** requested (card text, tier, PIN needed, the request or worker behind it), delivered (screen or phone channel), decided (who, how, address; only "PIN used", never the PIN), or timed out, or a stale or duplicate answer.
5. **Office:** worker run start, stop, crash and budget stops; each tool the worker used; each request it made with who answered it (rule, quick check, memory, Maya, owner) and the reason; ticket status changes; the worker's report in full (up to the cap); hires, assignments, reviews and fires.
6. **Maya:** messages sent (recipient and text), files sent, `owner.notify`, memory and soul changes, settings she changed, model errors.
7. **Owner:** logins and failures, PIN failures, pairing and revoking devices, setting changes as key, old value and new value (secrets masked), plugin and connector changes, chat and voice requests (full text), emergency lock.
8. **Outsiders:** failed logins, refused hosts and origins, rejected Telegram, Twilio and Alexa calls; messages from strangers stored and marked untrusted.
9. **System:** start and stop with version, updates (from and to), config file changes made outside the app, migrations, compaction, errors.

**If a write fails:** anything that changes something is refused and the owner is alerted. Read-only work continues and is flagged `not recorded` so the gap is visible in the report.

A **coverage test** walks the tool registry, the non-GET routes and the WebSocket message types and fails if a state-changing action does not produce an entry.

## 4. Reading it

All access needs the owner's PIN. After a correct PIN the audit area stays unlocked for 10 minutes (a setting).

- **Screen** (Esc, Settings, Audit): time range, who (owner, Maya, each worker by name, outsiders), kind group (approvals, tools, workers, logins, messages, settings, system), result, text search. Quick views: Today, Needs attention (refused, failed, refused approvals, outsider events, `not recorded`), one timeline per worker, an approvals list with who decided and why. "Follow this request" shows the tree of everything a request caused, in order, with times. "Verify chain" says OK or names the first broken entry and shows the last seal. All logged text is rendered as plain text, never HTML or links, and long values are cut with "show more".
- **Command line:** `friend audit list | show <request> | verify | export | seal`. It asks for the PIN and goes through the running Friend; it does not open the database directly.
- **Export:** JSON (with chain fields, verifiable elsewhere), CSV, and a printable HTML report (range, totals, needs-attention list, timelines). Secrets are masked again; files are marked private.
- **Ask Maya:** a tool `audit.search` that raises a PIN card on the screen each time, like a dangerous approval. Nothing is returned until the PIN is typed. It returns at most 200 matching rows, labelled as untrusted data.

## 5. Protecting the trail

- **Daily seal:** at a set time (default 09:00) Friend sends one line (row count and the last hash) to the owner's phone through the same Telegram, WhatsApp, SMS way as other notices, and writes it into the log. `friend audit verify --seal <text>` checks that the log still holds that hash at that position. This detects a rewrite of the whole chain by someone who controls the PC.
- **Retention:** `audit.keepDays` (default 90; 0 keeps everything). Before old rows are removed Friend writes a checkpoint (range, count, final hash) and, unless `audit.archive` is off, a compressed archive file in `~/.friend/audit-archive/` that still verifies. The removal itself is logged.
- **No edit routes:** no screen or API changes or deletes a row. The database also refuses UPDATE and DELETE on `audit_log` (triggers) except inside the pruning step. This stops bugs and careless edits; it does not stop someone with full control of the PC removing the triggers, which is what the seal is for.
- **Size:** detail capped at 8 KB per entry; larger values are cut with the hash of the whole.

## 6. Settings

`audit.keepDays` (90), `audit.archive` (true), `audit.sealAt` ("09:00", empty turns the seal off), `audit.unlockMinutes` (10). All owner-only (not changeable by the assistant) and listed in `friend config keys`.

## 7. Testing

- Chain: appending, editing a row, deleting a row, reordering, and a gap are all detected by verify; a legacy start-of-chain verifies.
- Masking: key names and value patterns, nested objects, the 8 KB cap with the hash of the whole.
- Request tracing: an owner request produces a tree with the tool call, the approval and the worker request linked by id and parent.
- Coverage test as above; write-ahead (`started` exists when a tool throws); refused-when-unrecorded.
- Retention: prune writes the checkpoint and archive, verify still passes afterwards.
- Seal: sent through the reach order, verified, and fails after tampering.
- Access: no PIN, no data; expired unlock; `audit.search` returns nothing before the PIN; output is labelled untrusted.
- UI: renders untrusted text as plain text; filters and follow-this-request on seeded data.
- Migration: an existing database with old rows migrates and verifies.

## 8. Rollout

Migration 16 adds the columns and the start-of-chain entry. The report screen, CLI, export, the seal and `audit.search` ship together so the log is never recorded without a way to read it. Existing log calls keep working unchanged and gain the new fields from context.

## Open points for the plan

- The exact unlock mechanism for the audit area (a short-lived flag on the session after PIN) and how the CLI obtains it.
- Which of the existing log calls should be moved to the choke-point recording to avoid duplicates (for example `tool.call` and `office.approval`).
- How the worker's own tool events are read from the Claude Code stream and mapped to entries.
