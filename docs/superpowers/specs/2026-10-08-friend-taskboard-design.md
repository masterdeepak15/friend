# Friend Taskboard and Heartbeat Design Spec and Plan

Date: 2026-10-08 · Status: approved by delegation ("yes do it all")

## 1. Purpose
The owner says "remind me to call the bank at 5" or "every Monday remind me to back up" and Friend does it. A **heartbeat** inside the server checks for due tasks and tells the owner. Friend never acts on its own: a due reminder only notifies.

## 2. Design
- Table `tasks(id, title, due_at null, repeat null, status 'open'|'done', created_at, fired_at null)`, migration 4. Max **200** open tasks, titles up to **200** characters.
- Tools (owner turns only), tier T1, handled in the gateway:
  - `task.add {title, inMinutes?: number, dueAt?: string (ISO 8601 with offset), repeat?: "hourly"|"daily"|"weekly"}`: `inMinutes` (1 to 525600) or `dueAt` sets the time; with neither it is a plain to-do. A time in the past is refused. `repeat` needs a time.
  - `task.list {}`: open tasks, soonest due first (to-dos without a time last), as `#id title (due ...)` lines; done tasks are not listed.
  - `task.done {id}`: marks done; a repeating task is rescheduled instead of closed.
  - `task.remove {id}`.
- The system prompt for owner turns gets `Current time: <local ISO with offset>` so the model can turn "at 5pm" into `dueAt`.
- **Heartbeat** (`Heartbeat` class, interval 15 s, configurable in tests): finds open tasks with `due_at <= now` and `fired_at is null`. If at least one owner browser is connected and the agent is not busy: broadcast an `alert` (info, "Reminder: title"), show a stage card `reminder-<id>` (ttl 90 s), speak "Reminder: title" when voice is available, audit `task.fired`, and set `fired_at`. A repeating task is rescheduled to the next slot after now (skipping missed slots, never firing a backlog) and `fired_at` cleared. With nobody connected it waits and fires when the owner returns (within one heartbeat).
- A reminder is never turned into a model turn and never runs a tool. Notes in titles are shown as text.
- The emergency lock does not delete tasks, but a locked session sees reminders only after logging in again.
- Out: calendar integrations, natural language parsing on the server, push notifications to a phone, tasks that run commands.

## 3. Tests
Store: add (plain, `inMinutes`, `dueAt`, past refused, repeat without time refused, caps), list order, done (one-off and repeating reschedule), remove, due selection, fire marking. Agent: each tool, prompt carries the time, guests have no tools. Heartbeat: fires once, shows alert + card, speaks, repeats without backlog, waits without clients, skips while busy, stops on `stop()`. Integration: scripted model adds a task due in a moment; the heartbeat notifies the connected client.

## 4. Plan
1. Store + migration + protocol tools (tests first), commit.
2. Agent wiring + prompt time (tests first), commit.
3. Heartbeat + app wiring + integration test, docs, merge to `main`.
