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
- **The always-ask actions** (a camera picture, sending a file, an Office worker's request), unless you turn that on.
- A reply from anyone but your own linked chat is ignored, and so is a button tapped by anyone else.

## Settings

Esc, Settings, Approvals, "When you are away from the screen" (changing them needs your PIN). Or by command:

```bash
friend config set phoneApprovals.enabled false          # never ask on the phone
friend config set phoneApprovals.channel telegram       # auto, telegram or whatsapp
friend config set phoneApprovals.delaySec 0             # also ask the phone at once when a screen is open
friend config set phoneApprovals.buttons false          # Telegram: reply YES or NO instead
friend config set phoneApprovals.allowRisky true        # the phone may also answer the camera, files and Office
```

Alexa has its own version of this: a request from a speaker is sent to your phone as "reply YES" and is not asked twice.
Every phone answer is written to the audit log (`approval.phone`).
