# Meetings: the assistant joins your Teams, Google Meet and Zoom calls

Friend can join a Microsoft Teams, Google Meet or Zoom meeting as a **guest**, listen, take notes, tell you on your phone when something concerns you, and send you the summary and the tasks afterwards. It costs nothing: it uses the Chrome or Edge already on your PC and Teams' own live captions. No meeting service, no extra account, no speech model.

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
- **Only meeting addresses of the three sites are opened**: Teams (`teams.microsoft.com`, `teams.live.com`, `teams.cloud.microsoft`), Google Meet (`meet.google.com/abc-defg-hij`) and Zoom (`zoom.us/j/number`, which Friend opens in the browser version). Over https, with no port or login in the address.
- **The browser is private:** a fresh profile with no sign-ins or cookies, deleted afterwards. If the page goes anywhere that is not a Microsoft address it stops.
- **One meeting at a time.** At most six messages to you in ten minutes.
- The audit trail records which meeting, never the words.

## Limits to know

- **Live captions must be available.** The organiser can turn them off, and then Friend says so and cannot hear. (Listening to the audio itself is planned.)
- **Guest join can be blocked** by a company's Teams settings, and some meetings need the organiser to let you in.
- **The sites change their pages.** Everything that depends on a page is in one file per site (`teamsDom.ts`, `meetDom.ts`, `zoomDom.ts`: the words and attributes it looks for, each with more than one way). The join, captions and chat flow was tested against a page shaped like Teams in a real Chrome, and the Meet and Zoom scripts were checked to run without errors; none has been tried against a live call yet. If a step fails, Friend tells you at which one.
- **Meet and Zoom guests:** Google Meet lets a guest in only when the host admits them. Zoom needs the browser version enabled by the host, and a passcode in the link (or none).
- **Recording people:** telling the room it takes notes is built in and cannot be switched off. Some places require everyone's consent to record.
- The PC must be on and awake at meeting time.

## Invitations in mail

When the Mailboxes plugin is on and a mail that is not from you carries a meeting link, Friend tells you on your phone ("A meeting invitation arrived in Support from ann@...: ...; tell me to join it and when"), at most five an hour. It never joins by itself from a mail: you say so, and it asks you. A mail from you with a link is an order like any other: it works out the time and asks before it joins.

## The screen

**Plugins, Meetings, Configure** lists the meetings with their state, the notes, decisions and tasks, and has buttons to make it leave, cancel a scheduled one or delete one that is over.

## Later

Speaking aloud when called, and listening to the audio when captions are off. Both need a virtual audio device installed on the PC (a driver), so they are left out until you want them.
