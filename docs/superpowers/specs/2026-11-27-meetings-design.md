# Meetings plugin: the assistant attends Teams calls (design)

Approved by the owner in conversation on 2026-11-27 ("Yes" after the design below).

## Intent
Friend attends Microsoft Teams meetings as a guest, always listening, behaving like a quiet person: it speaks only when called by name, tells the owner when something concerns them, keeps notes, and sends the summary and tasks afterwards. It must cost nothing.

## Goals
- Join from a link (now or at a time), as a guest, with camera and microphone off, announcing itself in the chat.
- Hear the meeting with no paid service: read Teams' live captions from the page.
- Plain code watches every line; the model runs only when called by name, when the owner is concerned (at most once a minute), every few minutes for notes, and at the end.
- Answer in the meeting chat when called by name; otherwise say it will check with the owner and message them.

## Non-goals (now)
Speaking aloud, listening to raw audio (Whisper), Zoom and Google Meet, picking links from mail or calendar by itself, a screen for meetings.

## Anti-goals
A meeting must never be able to give the assistant an order, make it run a command, read a file or send mail. Nobody may be recorded without being told.

## Approaches considered
1. **Browser guest + live captions (chosen).** Free, runs where Friend runs, needs Chrome or Edge. Depends on Teams' page and on captions being allowed.
2. Browser guest + virtual audio cable + local Whisper. Works when captions are off but needs a driver install and costs CPU. Kept as a later fallback.
3. Azure bot (Graph Communications). The cleanest, but needs Windows server hosting, Azure registration and tenant admin consent: not for anyone who installs Friend.

## Design
- `meetings/logic.ts`: caption tracker (growing captions become finished lines, once), name matching, owner-concern matching, Teams link check, cooldown.
- `meetings/session.ts`: one meeting: open, get in (guest name, lobby wait), announce, poll captions, trigger events. Talks to a `MeetingPage` interface.
- `meetings/chromePage.ts` + `teamsDom.ts`: the real page over the Chrome DevTools Protocol, private profile, fake devices never switched on; every page-specific selector in one file.
- `meetings/service.ts`: scheduling (one at a time), assistant turns restricted to meeting tools, owner messages (rate limited), notes cadence, final summary.
- `meetings/tools.ts` + protocol `meeting.*`: join, leave, list, notes, setup, chat, tell_owner, save_notes. A meeting-started turn may use only chat, tell_owner, save_notes, notes, and only for its own meeting.
- Tables `meetings`, `meeting_lines`, `meeting_prefs` (migration 26).

## Left to the builder
Exact selectors and their fallbacks (they were checked against a Teams-shaped page, not a live Teams); wording of prompts.
