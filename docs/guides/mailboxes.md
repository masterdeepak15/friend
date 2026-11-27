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

## Later

Mail rules and templates (for example a daily status email, or a server-down alert), agents hired in the Office with their own mailbox and role, and sign-in with Google or Microsoft instead of an app password are planned. See `docs/superpowers/specs/2026-11-27-agent-mailboxes-design.md`.
