# Meetings: the assistant joins your Teams calls

Friend can join a Microsoft Teams meeting as a **guest**, listen, take notes, tell you on your phone when something concerns you, and send you the summary and the tasks afterwards. It costs nothing: it uses the Chrome or Edge already on your PC and Teams' own live captions. No meeting service, no extra account, no speech model.

## Set it up

1. **Plugins**, find **Meetings** under *Available*, press **Install** (PIN), then **Turn on** (PIN). Chrome or Edge must be on the PC where Friend runs.
2. Tell Friend how people call you and what you want to hear about, once:
   "In meetings people call you Maya or Mia, call me Deepak or DC, and tell me when invoice or budget comes up."
   Friend shows the change and you approve it (`meeting.setup`).

## Use it

- "Join this meeting: *link*" (now), or "Join this meeting at 3pm tomorrow: *link*" (Friend joins by itself a minute early).
- "Leave the meeting." "What are the notes of the last meeting?" "What did they decide?"
- Friend asks you before it joins or schedules a join, and shows the address and time.

## What it does in the meeting

| | |
|---|---|
| **Joins** | in a private Chrome of its own, as a guest named after the assistant, with camera and microphone off. Someone has to let it in from the lobby (if the meeting has one). |
| **Says it is there** | one line in the chat when it arrives: it is an AI assistant taking notes, and speaks only when asked by name. |
| **Listens** | by reading Teams' live captions. Plain code watches every line: no model is used until something needs it. |
| **Called by name** | waits for the speaker to finish, then answers in a sentence or two **in the chat**. If it cannot answer or it needs you, it says it will check with you and messages you. |
| **Concerns you** | your name or one of your topics comes up: it messages you on your phone with what was said and a suggested answer (at most once a minute). Your own words never trigger it. |
| **Notes** | every few minutes it brings the notes up to date (summary, decisions, tasks with owner and due date); at the end it writes the final notes and messages you the summary. The whole transcript is kept on this PC. |
| **Never** | speaks unless called by name, writes in the chat more than once every 15 seconds, or does anything for someone in the meeting. |

## What always holds

- **Only you give orders.** Everything said in a meeting comes from other people and is information. A turn that a meeting starts can use four tools only: write in that meeting's chat, message you, read and save notes. It cannot run commands, read files, send mail or join another meeting, whatever is said.
- **Only Teams addresses are opened** (`teams.microsoft.com`, `teams.live.com`, `teams.cloud.microsoft`, over https, no port or login in the address).
- **The browser is private:** a fresh profile with no sign-ins or cookies, deleted afterwards. If the page goes anywhere that is not a Microsoft address it stops.
- **One meeting at a time.** At most six messages to you in ten minutes.
- The audit trail records which meeting, never the words.

## Limits to know

- **Live captions must be available.** The organiser can turn them off, and then Friend says so and cannot hear. (Listening to the audio itself is planned.)
- **Guest join can be blocked** by a company's Teams settings, and some meetings need the organiser to let you in.
- **Teams changes its page.** Everything that depends on the page is in `packages/server/src/meetings/teamsDom.ts` (the words and attributes it looks for, each with more than one way). It was tested against a page shaped like Teams in a real Chrome, not yet against a live Teams meeting: if a step fails, Friend tells you at which one.
- **Recording people:** telling the room it takes notes is built in and cannot be switched off. Some places require everyone's consent to record.
- The PC must be on and awake at meeting time.

## Later

Speaking aloud when called (free local voice through a virtual microphone), listening to the audio when captions are off, picking up meeting links from your Mailboxes and calendar, Zoom and Google Meet, and a screen for meetings and notes.
