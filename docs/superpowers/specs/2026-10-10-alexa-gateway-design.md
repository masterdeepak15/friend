# Alexa gateway: talk to Friend from an Echo

Date: 2026-10-10. Status: draft for the owner's review.

## What the owner asked for

Use the Alexa devices at home as another way to talk to Friend, like Telegram and WhatsApp already are. "Alexa, ask Jarvis how my portfolio is" is answered by Friend. If a Friend screen is open, the answer also appears there; if not, Alexa just speaks it. Anything that needs approval is approved from Telegram or WhatsApp when one is linked, or skipped. English and Hindi. The owner will open the Alexa developer console; Friend stays self-hosted (no extra service, no cost).

## What is possible, and what is not

| Possible (checked against Amazon's documentation) | Not possible, or limited |
|---|---|
| A **custom skill** in the owner's own Amazon developer account, left in **development** (never published), works on every Echo signed in to the same Amazon account. No review, no fee. | **Marathi**: Alexa custom skills support English (IN) and Hindi (IN), not Marathi. |
| Friend's own web address is the skill's endpoint (needs a public HTTPS address on port 443 with a CA-signed certificate; the owner already has one). Self-signed is for testing only. | **Eight seconds**: Alexa waits about 8 s for a full reply. A slow model answer must be handled in a different way (see "Slow answers"). |
| Every request is signed by Amazon. Friend can verify the signature (certificate from `s3.amazonaws.com/echo.api/`, SAN `echo-api.amazon.com`, SHA-256 over the raw body) and the timestamp (150 s). | **Free speech**: Alexa only passes on what matches the skill's sample sentences. Free text goes in one `AMAZON.SearchQuery` slot per sentence, which needs a fixed lead-in ("how ...", "what ...", "tell me ..."). |
| The request carries `applicationId` (which skill), `userId` (which Amazon account), `deviceId` (which Echo), `locale`, and a `personId` when Alexa recognized a voice. | **Invocation name**: two or more words, lower case, no "ask/open/start/alexa/skill" and not a wake word. "Jarvis" alone is not allowed (except for registered brands), so the name is two words such as "jarvis assistant". It can be changed while in development. |
| Progressive responses (up to five) let Alexa say "Let me check" while Friend works. | **Friend cannot speak on its own** through an Echo (no proactive speech without Amazon's notification programme). Reports and approvals go to Telegram or WhatsApp instead. |
| Speech up to 8000 characters, 120 KB per response. | **Calling** and **hearing the room**: out of scope. |

## Decisions already made by the owner

1. First version: **ask and hear answers** (portfolio, weather, tasks, notes, status, and general questions). The invocation name is the assistant's name, so "ask Jarvis" works (as a two-word name).
2. Screen connected: show the answer on the Friend screen as well; no screen: speak only.
3. When something needs permission: ask on **Telegram/WhatsApp** if one is linked; otherwise skip it.
4. Languages: **English (India) and Hindi (India)**.
5. The Alexa console steps are done with Chrome control, after the owner reconnects it. Everything on the Friend side is built first.

## Design

**Endpoint.** `POST /api/alexa`, no cookie. It is accepted only when (a) the signature and timestamp verify, (b) `applicationId` equals the skill id saved in Friend, and (c) the `userId` is on the owner's allowed list. Anything else gets 400/403 and a line in the audit log, never a spoken answer. A small rate limit applies per address.

**Pairing.** An unknown `userId` is recorded as "waiting" with the device id and time. Alexa says "I do not know this Echo yet. Allow it in Friend, under Plugins, Alexa." The owner presses **Allow** (PIN) on the Configure page. Allowed ids are kept in the config; **Forget** removes one. A voice code is never used as proof (a spoken PIN can be overheard).

**Sentences.** The skill has fixed intents for the common things (portfolio, weather, tasks, notes, status, stop/help) and a few "ask" intents with different lead-ins (`how {q}`, `what {q}`, `tell me {q}`, `show me {q}`, `remind me {q}`, `please {q}`). Fixed intents are answered straight from Friend's tools, with no model, so they are fast and cost nothing. The "ask" intents rebuild the sentence (lead-in plus slot) and hand it to the assistant.

**Trust level.** Alexa requests run with a new trust level, `voice-device`, that allows only reading tools (weather, tasks, notes, status, portfolio, schedule list, stage display). Anything else is "needs permission":
- A request that would normally ask the owner (T2) becomes a message on Telegram or WhatsApp ("Alexa asked to ...: reply YES within 5 minutes"). The action runs only after that reply, and Alexa says "I asked you on Telegram."
- Anything that needs the PIN (T3) is refused on voice: "Do that at your PC." No PIN is ever spoken or typed in a chat.
- With no linked Telegram/WhatsApp, permission requests are skipped and Alexa says so.

**Slow answers.** Fixed intents answer at once. For the "ask" intents Friend sends a progressive response ("Let me check") and waits up to about 6.5 seconds. If the answer is not ready, Alexa says "Still working. Ask me if it is ready." and the finished answer is kept for 10 minutes for the "is it ready" intent. If the answer is long, Alexa speaks a short version and the full text goes to the Friend screen (if connected) or to Telegram/WhatsApp (if the owner said "send it to me").

**Screen.** If a Friend screen is connected the answer is also shown there as a normal object; Echo Show screens are not used in this version.

**Language.** The hi-IN model has the same intents in Hindi. The assistant answers in the language of the request; Hindi is written in Devanagari so Alexa's Hindi voice reads it.

**Setup on the Friend side.** An **Alexa** integration (Plugins, like Zerodha): skill id, invocation name, allowed devices list (waiting / allowed), the endpoint address to paste into the console, and **Download skill package** (interaction models for en-IN and hi-IN, and the skill manifest) so the owner can paste or upload them. Settings are PIN-protected, the assistant cannot change them, and the skill id is not a secret.

**Safety.** Signature check first, before any parsing of the body; raw body size limit (a few KB); the endpoint never echoes request text into logs beyond a short clip; Alexa-origin text is treated as the owner's words only if the device is allowed, but it is still "untrusted for actions": it cannot reach any tool outside the allowed list. Audit records the intent and device, not the spoken text.

## Can Friend message Alexa or stream media? (checked 2026-10-10)

The rule behind every row: Amazon lets a skill answer when the user speaks to it. It does not let a skill start talking through an Echo by itself.

| Idea | Official way | Verdict |
|---|---|---|
| Friend makes an Echo **say any text** on its own ("your report is ready") | None for a custom skill. | **Not possible officially.** |
| Friend **notifies** an Echo | Proactive Events API: the Echo's light ring turns yellow and the user asks "Alexa, what are my notifications". Amazon's fixed templates only (for example `AMAZON.MessageAlert.Activated`: "you have a message from <name>"); the skill needs the notifications permission and the user turns Notifications on for it in the Alexa app. Works for a skill in development. Amazon limits notifications per day. | **Possible, small.** Friend can say "1 new message from Friend"; the real text is then read out when the owner asks Friend. Optional. |
| **Scheduled** spoken reports ("every morning at 9:30, say my portfolio") | An **Alexa Routine** in the Alexa app with a time trigger and the action "ask <invocation name> for my portfolio report". The Echo speaks Friend's answer. | **Possible, and the best fit.** No code beyond the normal skill; the owner makes the routine once. (To be confirmed on the owner's Echo; Routines can start custom skills.) |
| **Reminders** that Alexa speaks | Alexa Reminders API (permission `alexa::alerts:reminders:skill:readwrite`, granted in the Alexa app). A skill can create a reminder while the owner is talking to it ("remind me to ..."). | **Possible only during a conversation.** Friend's own reminders keep going to the PC and Telegram. Optional. |
| **Stream media** to an Echo ("play my briefing", "play the radio") | AudioPlayer interface: the skill answers a spoken request with one HTTPS stream (port 443, CA-signed certificate) and Alexa plays it. Friend can serve its own audio (a spoken briefing made with its local voices, or an audio file the owner chose) at a short-lived link, or point at an internet radio URL. Pause, resume, stop work by voice. | **Possible, but only when the owner asks.** Friend cannot start playing on its own. Stream format details (codec, redirects) are in Amazon's long-form audio rules and are checked while building it. |
| **Start music** on an Echo from the PC without speaking | Only through Amazon's unofficial web interface (what some home-automation add-ons use): it needs the owner's Amazon login cookie stored on this PC, is against Amazon's terms in spirit, breaks when Amazon changes things, and gives full control of the Amazon account if the cookie leaks. | **Not recommended.** If ever added: a separate, clearly marked advanced plugin, off by default, owner-supplied cookie only. |

So, for the first version: voice in, answers out, plus **Routines for scheduled spoken reports** (documented in the setup guide). **Media streaming on request** is a second step after the basic skill works. Notifications and reminders are optional extras after that.

## Testing without Alexa

A fake Alexa signs requests with a test certificate that the verifier is told to trust, so signature, timestamp, application, user and device checks are all tested. Intent flows are tested against the real agent with a fake model. The first real Echo test is done together with the owner in the console.

## Out of scope for this version

Account linking, Echo Show screens (APL), proactive speech, publishing to the Alexa store, Marathi, calls and routines, controlling smart-home devices through Alexa, and any money-moving action.

## Tasks (outline)

1. Request verifier (signature, certificate chain, timestamp, application).
2. Alexa model: request in, speech out, session handling, slow-answer holder.
3. Allowed devices and pairing (config, waiting list, audit).
4. Voice trust level and the permission-by-message flow.
5. Intents and the fast paths (portfolio, weather, tasks, notes, status).
6. `/api/alexa` route, rate limit, app wiring.
7. Alexa integration entry, Configure page, settings and tests.
8. Skill package generator (en-IN, hi-IN models, manifest) and download.
9. Documentation, console walk-through (with Chrome control), release.
