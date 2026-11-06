# Approving from your phone

When Friend needs your OK for something and you are not at the screen, it asks you on your phone instead of waiting
until the request times out and is refused.

## What you see

- **Telegram:** a message "Friend needs your OK" with what it wants to do, and two buttons, **Allow** and **Deny**. After you
  tap (or answer on the screen) the message is rewritten with the result and the buttons go away.
- **WhatsApp (or Telegram with buttons off):** the same message ending "Reply YES 1 to allow it, or NO 1 to refuse."
  If only one request is waiting, a plain YES or NO is enough (also "haan" and "nahi"). If several are waiting, use the number.
- If you have a Friend screen open, it shows the same card. **Whichever you answer first wins**; the other is closed.

## When the phone is asked

- No screen open: at once.
- A screen is open: after a wait you set (20 seconds by default), if nobody has answered it.
- Set up the app first: Plugins, Telegram (or WhatsApp and SMS), link your chat. Friend only ever writes to your own chat.

## What the phone can never do

- **Anything that needs your PIN.** A PIN is never typed in a chat. Those wait for the screen.
- **"Always allow".** Only the screen can add a rule.
- **The camera and Office workers' requests**, unless you turn that on. (Sending a file to your own chat can be answered on the phone.)
- A reply from anyone but your own linked chat is ignored, and so is a button tapped by anyone else.

## Settings

Esc, Settings, Approvals, "When you are away from the screen" (changing them needs your PIN). Or by command:

```bash
friend config set phoneApprovals.enabled false          # never ask on the phone
friend config set phoneApprovals.channel telegram       # auto, telegram or whatsapp
friend config set phoneApprovals.delaySec 0             # also ask the phone at once when a screen is open
friend config set phoneApprovals.buttons false          # Telegram: reply YES or NO instead
friend config set phoneApprovals.allowRisky true        # the phone may also answer the camera and Office requests
```

Alexa has its own version of this: a request from a speaker is sent to your phone as "reply YES" and is not asked twice.
Every phone answer is written to the audit log (`approval.phone`).

## Hired workers (the Office)

You do not have to answer the requests of your hired workers yourself. Settings, Office, "How much does Friend answer itself":

- **Your assistant decides**: for each request the assistant weighs the worker's job, the ticket, the project goal and the exact action, like a careful senior engineer. It allows what the ticket needs and refuses what could harm, tells the worker why, and writes its reason in the Office feed and the audit log. If it cannot decide (the model is down or unclear), you are asked, on your phone if away. It is never a silent "yes".
- The fixed refusals stay in every level: anything outside the project folders, the files that control a worker, and the commands you listed as refused. The assistant is not asked about those.

### "Your assistant, herself"

The third Office level makes your assistant answer each worker request in her own conversation, with everything she knows about you and your projects (it is the way a team lead would answer, not a separate quick check).

- The request is written down first (see the table `office_requests` and the audit log), the worker is paused, and your assistant is asked as soon as she is free. If she is in the middle of something, the worker waits; she is never interrupted and nothing is skipped or dropped, even when several requests (and finished tickets) pile up.
- She answers with `office.decide`: allow, deny, or ask you (you are asked on your phone if you are away). Her reason goes to the worker and into the Office feed.
- A request she leaves unanswered is put to her again, up to "Times the assistant is asked" (3 by default). After that it goes to you as a normal approval card. Silence never means yes.
- The fixed refusals (outside the project folders, files that control a worker, commands you refuse) are decided before and never reach her.
- If Friend restarts, the workers stop and what they were waiting for is closed.
