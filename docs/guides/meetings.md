# Meetings: the assistant joins your Teams, Google Meet and Zoom calls

Friend can join a Microsoft Teams, Google Meet or Zoom meeting as a **guest**, listen, take notes, tell you on your phone when something concerns you, and send you the summary and the tasks afterwards. It costs nothing: it uses the Chrome or Edge already on your PC and the meeting's own live captions. No meeting service, no extra account, no driver. It can answer aloud and hear a meeting that has no captions, using the voice engine Friend already has.

## Set it up

1. **Plugins**, find **Meetings** under *Available*, press **Install** (PIN), then **Turn on** (PIN). Chrome or Edge must be on the PC where Friend runs.
2. Tell Friend how people call you and what you want to hear about, once:
   "In meetings people call you Maya or Mia, call me Deepak or DC, and tell me when invoice or budget comes up."
   Friend shows the change and you approve it (`meeting.setup`).

## Use it

- "Join this meeting: *link*" (now), or "Join this meeting at 3pm tomorrow: *link*" (Friend joins by itself a minute early).
- "Leave the meeting." "What are the notes of the last meeting?" "What did they decide?"
- Asking Friend to join (or sending it the invitation) is the approval: it does not ask again. It tells you when it has joined.

## What it does in the meeting

| | |
|---|---|
| **Joins** | in a private Chrome of its own, as a guest named after the assistant, with its microphone off and its camera showing an animated picture of the assistant (a glowing orb that pulses when it listens and spreads rings while it speaks, with its name). Someone has to let it in from the lobby (if the meeting has one). |
| **Says it is there** | one line in the chat when it arrives: it is an AI assistant taking notes, and speaks only when asked by name. |
| **Listens** | by reading Teams' live captions. Plain code watches every line: no model is used until something needs it. |
| **Called by name** | waits for the speaker to finish, then answers in a sentence or two **in the chat**. If it cannot answer or it needs you, it says it will check with you and messages you. |
| **Concerns you** | your name or one of your topics comes up: it messages you on your phone with what was said and a suggested answer (at most once a minute). Your own words never trigger it. |
| **Notes** | every few minutes it brings the notes up to date (summary, decisions, tasks with owner and due date); at the end it writes the final notes and messages you the summary. The whole transcript is kept on this PC. |
| **Never** | speaks unless called by name, writes in the chat more than once every 15 seconds, or does anything for someone in the meeting. |

## What always holds

- **Only you give orders.** What other people say in a meeting is information. A turn started by anyone else can use only a few tools: write in that meeting's chat, speak, message you, read and save notes. It cannot run commands, read files, send mail or join another meeting, whatever is said. **When you speak and the voice engine recognises you** (your enrolled voiceprint, not a name on a caption, which anyone can choose), your words are orders and Maya has all her usual tools in the call, including leaving it (meeting.leave): say Maya, leave the call or ask her to look something up or do something for you.
- **Only meeting addresses of the three sites are opened**: Teams (`teams.microsoft.com`, `teams.live.com`, `teams.cloud.microsoft`), Google Meet (`meet.google.com/abc-defg-hij`) and Zoom (`zoom.us/j/number`, which Friend opens in the browser version). Over https, with no port or login in the address.
- **The browser is private:** a fresh profile with no sign-ins or cookies, deleted afterwards. If the page goes anywhere that is not a Microsoft address it stops.
- **One meeting at a time.** At most six messages to you in ten minutes.
- The audit trail records which meeting, never the words.

## Limits to know

- **Live captions are best.** The organiser can turn them off. Then Friend says so, and listens to the sound with the voice engine instead (below).
- **Guest join can be blocked** by a company's Teams settings, and some meetings need the organiser to let you in.
- **The sites change their pages.** Everything that depends on a page is in one file per site (`teamsDom.ts`, `meetDom.ts`, `zoomDom.ts`: the words and attributes it looks for, each with more than one way). The join, captions and chat flow was tested against a page shaped like Teams in a real Chrome, and the Meet and Zoom scripts were checked to run without errors; none has been tried against a live call yet. If a step fails, Friend tells you at which one.
- **Meet and Zoom guests:** Google Meet lets a guest in only when the host admits them. Zoom needs the browser version enabled by the host, and a passcode in the link (or none).
- **Recording people:** telling the room it takes notes is built in and cannot be switched off. Some places require everyone's consent to record.
- The PC must be on and awake at meeting time.

## Invitations in mail

When the Mailboxes plugin is on and a mail that is not from you carries a meeting link, Friend tells you on your phone ("A meeting invitation arrived in Support from ann@...: ...; tell me to join it and when"), at most five an hour. It never joins by itself from a mail: you say so, and it asks you. A mail from you with a link is an order like any other: it works out the time and asks before it joins.

## The screen

**Plugins, Meetings, Configure** lists the meetings with their state, the notes, decisions and tasks, and has buttons to make it leave, cancel a scheduled one or delete one that is over.

## Answering aloud (on by default)

It is on unless you say "In meetings, only write in the chat" (`meeting.setup speak: false`, which you approve). When someone calls it by name, it speaks the answer in the voice your PC already has (Windows speech, macOS `say`, or `espeak-ng` on Linux), and writes it in the chat only if speaking fails.

- No driver and no virtual microphone: the browser's microphone for the meeting is a stream Friend makes itself. It is silent, and **muted in the meeting**, until Friend has something to say. It then switches the microphone on, plays the voice, and switches it off again.
- It waits until nobody is talking, speaks at most once every 20 seconds, and keeps each answer to one or two short sentences.
- The voice is the voice you already picked for Friend.
- The announcement in the chat when it arrives still says it is an AI assistant.

## Hearing a meeting that has no captions

When live captions are off, Friend listens to the sound of the call itself and reads it with **the same voice engine it already uses for the app** (the one you talk to with Space). Nothing to install or set up, no separate model: if the voice engine is running, meetings use it, for listening and for speaking.

How it works: the browser hands Friend the sound of the other people (the call's incoming audio tracks, not your PC's speakers), in pieces cut at the pauses. Pieces with no speech in them are never sent to the engine, and the sound is never saved. Each piece becomes a line, from the person whose voiceprint Friend knows (you, and the people you added under Voice) or from "Someone" and goes through the same rules as captions (answers by name, tells you what concerns you, notes). If the voice engine is not running there is nothing to read the sound with, and Friend says so.

Limits: it can name only voices Friend has been taught (enrol yours in the app first), everyone else is "Someone"; it is a few seconds behind the conversation; and the engine sometimes mishears names. Captions are used again as soon as they come back.
## Memory in a call

A meeting turn is short: a small note and only the lines said since her last turn, not the whole call again. What was said before is in her memory like any conversation, and she reads it back with the notes tool (meeting.notes with lines) or her memory when she needs it. This keeps long calls fast and the chat history small.

## Talking like a person

It listens all the time and watches for the room going quiet, so it never starts over someone and answers a moment after the pause. For 45 seconds after it was called or answered, a follow-up counts as meant for it even without its name; it stays quiet if the line is clearly people talking among themselves. It does not listen to its own voice (sound that arrives while it speaks, and for 3 seconds after, is ignored), and a name the speech engine garbled ("Umayyad" for "Maya") still counts.

## The chat, the names and the screen

- **Chat.** What people write in the meeting chat is read like what they say: it is kept with their name, and a message that calls the assistant by name is answered. `meeting.read_chat` reads it on demand. A message the assistant writes is checked against the chat list on the page; if it does not appear there, the tool says it failed instead of claiming it was written.
- **Names.** Without captions, a voice that is not the owner's is named by the meeting: whoever the page shows speaking just then, or the one other person there. If it cannot tell, it says "Someone" rather than guess. `meeting.people` lists who is there.
- **Presenting.** When the owner asks, `meeting.present` shares the call's screen: slides the assistant writes, or a picture or film from a file on the PC. The meeting sees a stage of its own, never the real screen, and nothing is installed. Give each slide something to say and she talks through the slides aloud, turning to the next slide as each one is told, so what is shown and what is heard stay together; speaking to her stops the talk so she can answer. Whether a guest may share depends on the meeting; if it may not, the tool says so.
- **Speed.** The voice is made while it waits for the room to go quiet, a pause of about a second ends a sentence, and the time of each step is in the audit trail (`meeting.timing`).

## Not built

Recognising the owner by voice, joining from mail without you, and calendar integration.