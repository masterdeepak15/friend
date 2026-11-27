# Mailboxes: email accounts for your assistant

Give Friend an email address of its own, set up like an account in Outlook. It reads new mail, can look things up in it, and answers or sends mail from that address. Only mail that is **proven to come from you** can give it an order. Mail from anyone else is only information: Friend reads it, and can write a reply to that person, but nothing inside it can make Friend do something else.

## Add a mailbox

0. **Once:** open **Plugins**, find **Mailboxes** under *Available*, press **Install** (PIN), then **Turn on** (PIN).
1. Press **Configure**, then **Add a mailbox**.
2. Choose **Gmail**, **Microsoft 365 / Outlook** or **Other**. This fills in the server names. Then give:
   - a **name** (how Friend calls it, for example "Support"),
   - the **email address** and its **password**,
   - **your addresses**: the ones you write from. Only mail proven to come from one of these can give an order,
   - optionally **system senders**: a monitoring service or similar, as an address or `@domain`. They can never give an order.
3. Press **Continue**, enter your **PIN**. Friend tries the login first: nothing is saved if it is refused, and it tells you why.

### The password

Use an **app password**, not your normal one:

- **Gmail:** Google account, Security, 2-step verification, **App passwords**. IMAP must be switched on in Gmail settings. (IMAP `imap.gmail.com` 993, SMTP `smtp.gmail.com` 465.)
- **Microsoft 365 / Outlook:** an app password, or ask your admin to allow IMAP and SMTP sign-in for that mailbox. (IMAP `outlook.office365.com` 993, SMTP `smtp.office365.com` 587.)
- **Other hosts:** the IMAP and SMTP server names and ports are in your provider's help.

The password is kept **sealed in Friend's vault**. It is never shown again, never written to a log, never sent to the model, and removing the mailbox deletes it. A password that stops working shows the mailbox as **needs sign-in**: press **Test login** after fixing it.

## What Friend does with mail

Every mail that arrives is classified before any model sees it:

| From | Counts as | What it can cause |
|---|---|---|
| One of your addresses, with the mail server's DKIM or SPF check passing for that domain (and no DMARC failure) | **owner** | An order. Friend does it, then answers with `email.reply` |
| A system sender you listed | **system** | Information |
| Anyone else, or an address of yours that fails the check (forged) | **other** | Information |

Mail that is a newsletter, a list, a no-reply address, an auto-reply or sent by the mailbox itself never starts anything, even from you.

Friend shows mail to the model marked as untrusted content, with the class stated first. Its instructions say never to obey requests inside mail, and the rules below are enforced in code, so even a model that was fooled cannot break them.

## What always holds (not settings)

- **Mail from someone else** can only ever be answered to that person: no forwarding, no other recipient.
- **Never answered:** bulk mail, mailing lists, no-reply addresses, automatic replies.
- **At most 3 mails per person per hour** and **30 per mailbox per hour**.
- **A new recipient** (someone this mailbox never wrote to or heard from) **always asks you**.
- After Friend has **read mail from a stranger**, every send asks you for the next 10 minutes, whatever you allowed.
- **Replies are marked** `Auto-Submitted: auto-replied`, so other robots do not answer them.
- **Attachments** are listed, never opened or run.
- **Nothing is deleted.** *Archive* only moves a mail out of the inbox.
- The audit trail records each send: the mailbox, the recipient, the subject length, who approved it. **Never the text.**

## What it may send by itself (the ladder)

Under **What it may send**, per mailbox, for new mail, replies and forwarding: **ask me every time** (the default) or **send by itself**. "By itself" applies only to people the mailbox already knows, and never to a reply caused by mail from someone else. Changing it needs your PIN.

## The tools

`email.inbox`, `email.read`, `email.search`, `email.send`, `email.reply`, `email.forward`, `email.draft` (kept for you, not sent), `email.mark_read`, `email.archive`, `email.attachments`. Each takes the mailbox name (leave it out when there is only one). They work only while the plugin is on, and only for you, the owner.

## Examples

Say: "Check the support inbox." / "Reply to the invoice mail and say it goes out today." / "Search the mail from Ann." And, from your own address: write "restart nginx and tell me" to the mailbox. Friend does it and answers by email (you are asked before it sends).

## Templates, rules, roles, schedules and watches

You set these up by **talking to Friend**: it proposes, shows you the full text, and you approve each one. (Mail from anyone else can never create or change any of them.)

- **Templates**: a mail with `{{values}}` to fill in, designed with you and saved by name ("server-down", "daily-status"). Friend fills it and sends it through the usual approval.
- **Rules**: what happens to mail that is *not* an order, by conditions (sender or `@domain`, recipient, words or a pattern in the subject, words in the text, has an attachment, attachment type). The first rule that matches decides: **ignore**, **notify** (Friend tells you) or **role** (hand it to a role).
- **Roles**: a job for a mailbox, with written guidelines ("Support agent: answer billing questions kindly, never promise refunds"). A role works through the mailbox tools only. While it handles someone's mail, Friend can do nothing else: no files, no commands, no other tools, whatever the mail says. It can answer that person and update its **case**; if you allowed it (**answers by itself**), the answer goes out without a card, but only to the person who wrote, and all the rules above still hold. Otherwise every answer asks you first. Bulk mail, robots and the mailbox's own mail never reach a role.
- **Cases**: one per conversation, with a status (open, waiting, done, **escalated**) and a one-line note. When a role escalates, Friend tells you.
- **Schedules**: "every day at 08:00, email me the status of my servers with the template daily-status", or every N minutes. They run as you, so the approvals you set for sending still apply.
- **Watches**: a web address (or a host and port) checked by plain code on its own interval. Friend is woken **only when it changes**: down after two failed checks in a row, up again after one good one. While all is well it costs nothing.

### Example: an IT monitor

Say: "Hire someone to watch my shop and email me." Friend proposes a watch on `https://shop.example.com` every 5 minutes with the instruction "email me an alert with the template server-down", a template `server-down`, and a schedule at 08:00 for a status mail with the template `daily-status`. You approve each. Nothing is sent without your approval unless you allowed that kind of mail to go by itself.

### Example: a support address

Say: "Make support@example.com answer billing questions." Friend adds the mailbox, a role **Support agent** with the guidelines you agree on, and a rule *subject contains "invoice" → role*. Start with answers that ask you first. When you trust it, allow the role to answer by itself: it still answers only the person who wrote, never forwards, never writes to a third person and never answers a robot.

## Later

Pages for roles and cases in the Mailboxes screen (today you see and change them by asking Friend), and sign-in with Google or Microsoft instead of an app password. See `docs/superpowers/specs/2026-11-27-agent-mailboxes-design.md`.
