# Agent Mailboxes, Phases 2 and 3 (rules, templates, schedules, watches, roles and cases)

> Spec: `docs/superpowers/specs/2026-11-27-agent-mailboxes-design.md`. Builds on phase 1 (`2026-11-27-agent-mailboxes-phase1.md`). Executed inline, TDD, one commit per task.

**Goal:** Any role (support, IT monitor, ...) can be given a mailbox, written guidelines and limits; mail, schedules and watches wake it; every send still passes the phase 1 guards and ladder.

## Rulings (decided here, in the spirit of the spec)

- **A role runs on Friend's own assistant loop**, not on a Claude Code Office worker: those workers only see Claude Code's tools, so the mail guards could not be enforced for them. Roles are listed and managed with the assistant (and shown as cases); the Office board itself is not changed.
- **A turn started by someone else's mail is tool-restricted in code**: only `email.*` (read, reply, draft, tidy, case) are callable, the cause is "inbound-other" (sends only to that sender, never forward), whatever the model asks for. A role may opt in (owner approves) to answering the sender **by itself**; nothing else is ever waived.
- **Standing orders need the owner's approval**: creating or changing a rule, role, schedule or watch asks the owner (card with the full text). Turns started by the owner's own schedules and watches run with owner trust (the instruction is the owner's), sends still follow the ladder.
- **Watches wake the assistant only on a change** (two failed checks in a row = down; one good = up) so monitoring costs no tokens while all is well.
- UI for these is by chat in this release (the assistant is the interface); the Mailboxes page stays the place for accounts.

## Tasks

1. **Protocol tools** (`protocol/src/mail.ts`): `email.template`, `email.rule`, `email.role`, `email.case`, `email.schedule`, `watch.manage` with action enums; describe lines. Test: schemas, no body in describe.
2. **Store** (migration 25 + `MailStore` methods): `mail_templates`, `mail_rules`, `mail_roles`, `mail_cases`, `mail_schedules`, `mail_watches`. Test: CRUD, cascade on mailbox delete, unique names.
3. **Pure logic**: `render.ts` (`{{var}}`, missing vars listed), `rules.ts` (`matchRule`: from, to, subject contains/regex, has attachment, attachment type, body contains; invalid regex never matches), `due.ts` (`scheduleDue` daily HH:MM local / every N minutes; no double fire; missed time fires once), `watchstate.ts` (`nextWatchState`). Tests for each, including DST-free edge cases and bad regex.
4. **Engines**: `MailAutomation` (30 s tick): runs due schedules and watch checks (`http`: status < 400 and optional text; `tcp`: connects) through an injected `checker` and `run(instruction, meta)`; skips when the assistant is busy and tries next tick; a watch fires `run` only on a state change. Tests with a fake clock and fake checker.
5. **Service/tools**: `MailService.send` ctx gains `roleAuto` (waives the inbound-other ask only for a reply to the sender when the role's ladder says auto and the recipient is the sender) and `ladder` override; `MailTools` implements the new tools, mutating actions ask the owner first. Tests: guard cases stay refused under roleAuto (forward, third person, automatic mail, rate limit).
6. **Loop**: `TurnCtx.mail` (`{ cause, from, roleId, accountId }`): in such a turn every tool outside the allowed email set fails; `email.*` gets that cause. Test: a model that asks for `shell.run` or `fs.read` in a role turn is refused.
7. **Wiring** (`app.ts`): on arrival, non-order mail goes through the mailbox's rules in order: `ignore`, `notify` (tell the owner), `role` (open or update a case, run the restricted turn; automatic mail never starts a role); automation start/stop with the plugin; the assistant prompt/guide text. E2E test: support mail + rule + role with auto answer = one reply to the sender only; injection mail forwards nothing; a watch going down runs the instruction once; a schedule fires once.
8. **Docs and release**: guide sections, README line, full checks, version 0.1.101 (0.1.100 is staged on npm), push, publish.
